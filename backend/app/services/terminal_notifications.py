"""Observe live control sequences without changing terminal bytes or replay.

OSC terminator BEL is not a bell. Strings other than known notification OSCs
are opaque, including embedded escapes in DCS/APC payloads. Storage is bounded.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from contextlib import suppress
from collections import OrderedDict
from datetime import timedelta

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from app.core.db import utc_now
from app.models.notification import TerminalNotification, notification_payload
from app.models.session import SessionRecord
from app.models.connection import Connection

logger = logging.getLogger(__name__)
_CONTROL = re.compile("[\x1b\x07\x90\x98\x9c\x9d\x9e\x9f]")
_END = re.compile("[\x07\x1b\x9c]")
KINDS = {"complete", "question", "approval", "attention", "bell"}


class TerminalNotificationParser:
    def __init__(self):
        self.state = "normal"
        self.pending = ""
        self.overflow = False
        self.escaped = False
        self.codex = False
        self.codex_state = "idle"
        self.codex_completion_at: float | None = None
        self.blocked_alerted = False
        self.claude_native = False
        self.claude_state = "idle"
        self.claude_alerted = False
        self.last_query_at = 0.0

    def feed(self, data: str) -> list[dict]:
        events = []
        index = 0
        while index < len(data):
            if self.state == "escape":
                char = data[index]
                self.state = "osc" if char == "]" else "string" if char in "P_X^" else "normal"
                self.pending = ""; self.overflow = False; self.escaped = False
                index += 1
                continue
            if self.state == "normal":
                match = _CONTROL.search(data, index)
                if not match:
                    break
                char = match.group()
                index = match.end()
                if char == "\x07":
                    events.append({"kind": "bell", "app": "terminal"})
                elif char == "\x1b":
                    self.state = "escape"
                elif char in "\x90\x98\x9d\x9e\x9f":
                    self.state = "osc" if char == "\x9d" else "string"
                    self.pending = ""; self.overflow = False; self.escaped = False
                continue
            if self.escaped:
                self.escaped = False
                if data[index] == "\\":
                    self._finish(events)
                    index += 1
                    continue
                # The ESC was inside an opaque string, never a new sequence.
            match = _END.search(data, index)
            end = match.start() if match else len(data)
            if self.state == "osc" and not self.overflow:
                if len(self.pending) + end - index > 4096:
                    self.pending = ""; self.overflow = True
                else:
                    self.pending += data[index:end]
            index = end
            if not match:
                break
            char = match.group(); index += 1
            if char == "\x1b":
                self.escaped = True
            elif char == "\x9c" or (char == "\x07" and self.state == "osc"):
                self._finish(events)
        return events

    def _finish(self, events: list[dict]):
        if self.state == "osc" and not self.overflow:
            event = self._osc(self.pending)
            if event:
                events.append(event)
        self.state = "normal"; self.pending = ""; self.escaped = False

    def _osc(self, payload: str) -> dict | None:
        if payload == "7501;?":
            now = time.monotonic()
            if now - self.last_query_at > 0.25:
                self.last_query_at = now
                return {"reply": "\x1b]7501;?supported=1\x1b\\"}
            return None
        if payload.startswith("7501;") and ":app=claude-code" in payload:
            fields = dict(part.split("=", 1) for part in payload[5:].split(":") if "=" in part)
            # Claude reports named background tasks with id=... separately.
            # Only its main session may finish the user's foreground turn.
            if fields.get("id"):
                return None
            self.claude_native = True
            self.codex_state = "idle"
            self.codex_completion_at = None
            previous = self.claude_state
            self.claude_state = fields.get("state", "")
            if self.claude_state == "working":
                self.claude_alerted = False
            elif self.claude_state in {"blocked", "waiting", "error"} and previous == "working" and not self.claude_alerted:
                self.claude_alerted = True
                kind = "approval" if fields.get("kind") == "permission" else "question" if fields.get("kind") == "question" else "attention"
                return {"kind": kind, "app": "claude"}
            elif self.claude_state == "done" and previous in {"working", "waiting", "blocked"}:
                return {"kind": "complete", "app": "claude"}
            return None
        if payload.startswith("7501;") and ":app=codex" in payload:
            self.codex = True
            self.codex_state = payload[5:].split(":", 1)[0].removeprefix("state=")
            if self.codex_state == "working":
                self.blocked_alerted = False
            if self.codex_state == "blocked" and not self.blocked_alerted:
                self.codex_completion_at = None
                self.blocked_alerted = True
                return {"kind": "attention", "app": "codex"}
            if self.codex_state == "idle":
                notified = self.codex_completion_at
                self.codex_completion_at = None
                if notified is not None and time.monotonic() - notified < 2:
                    return {"kind": "complete", "app": "codex"}
            return None
        if payload.startswith("777;notify;WebSSH Gateway;"):
            try:
                event = json.loads(payload.split(";", 3)[3])
                if not isinstance(event, dict) or event.get("kind") not in KINDS or event.get("app") not in {"codex", "claude"}:
                    return None
                if event["app"] == "claude" and self.claude_native:
                    if event["kind"] == "complete" or self.claude_alerted:
                        return None
                    if event["kind"] in {"question", "approval", "attention"}:
                        self.claude_alerted = True
                result = {"kind": event["kind"], "app": event["app"]}
                if isinstance(event.get("id"), str) and re.fullmatch(r"[a-zA-Z0-9:_-]{1,128}", event["id"]):
                    result["id"] = event["id"]
                return result
            except (ValueError, TypeError):
                return None
        if payload.startswith("9;") and not payload.startswith("9;4;"):
            if self.codex and self.codex_state in {"working", "blocked"}:
                if self.blocked_alerted:
                    return None
                # The next native state distinguishes a completion from a
                # question. OSC 9's body may be arbitrary assistant text.
                self.codex_completion_at = time.monotonic()
                return None
            return {"kind": "bell", "app": "terminal"}
        if payload.startswith("777;notify;"):
            return {"kind": "bell", "app": "terminal"}
        return None


class NotificationService:
    def __init__(self, database):
        self.database = database
        self.subscribers: dict[int, dict[object, asyncio.Queue]] = {}
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=512)
        self.worker: asyncio.Task | None = None
        self.cleanup_task: asyncio.Task | None = None
        self.closed = False
        self.recent: OrderedDict[tuple, float] = OrderedDict()

    def start(self):
        self.closed = False
        if self.cleanup_task is None or self.cleanup_task.done():
            self.cleanup_task = asyncio.create_task(self._cleanup_worker())

    async def _cleanup_worker(self):
        while True:
            try:
                await asyncio.to_thread(self._cleanup)
            except Exception:
                logger.exception("Could not clean expired terminal notifications")
            await asyncio.sleep(3600)

    def _cleanup(self):
        with self.database.session() as db:
            db.execute(delete(TerminalNotification).where(TerminalNotification.created_at < utc_now() - timedelta(days=7)))

    def observe(self, user_id: int, session_id: str, event: dict):
        if self.closed:
            return
        key = (session_id, event["app"], event["kind"], event.get("id"))
        now = time.monotonic()
        previous = self.recent.get(key)
        cooldown = 86400 if event.get("id") else 1 if event["app"] == "terminal" else 0
        if previous is not None and now - previous < cooldown:
            return
        self.recent[key] = now; self.recent.move_to_end(key)
        while len(self.recent) > 1024:
            self.recent.popitem(last=False)
        try:
            self.queue.put_nowait((user_id, session_id, dict(event)))
        except asyncio.QueueFull:
            logger.warning("Terminal notification queue full; session=%s", session_id)
            return
        if self.worker is None or self.worker.done():
            self.worker = asyncio.create_task(self._drain())

    async def _drain(self):
        while not self.queue.empty():
            user_id, session_id, event = self.queue.get_nowait()
            try:
                payload = await asyncio.to_thread(self._store, user_id, session_id, event)
                if payload:
                    self.broadcast(user_id, {"type": "notification", "event": payload})
            except Exception:
                logger.exception("Could not record terminal notification; session=%s", session_id)
            finally:
                self.queue.task_done()

    def _store(self, user_id: int, session_id: str, event: dict) -> dict | None:
        with self.database.session() as db:
            session = db.execute(select(SessionRecord).where(SessionRecord.id == session_id, SessionRecord.user_id == user_id)).scalar_one_or_none()
            if not session:
                return None
            source_key = f"{session_id}:{event['app']}:{event['id']}" if event.get("id") else None
            if source_key and db.execute(select(TerminalNotification.id).where(TerminalNotification.source_key == source_key)).first():
                return None
            name = db.scalar(select(Connection.name).where(Connection.id == session.connection_id))
            record = TerminalNotification(id=uuid.uuid4().hex, user_id=user_id, session_id=session_id,
                session_name=(session.title or name or session_id[:12])[:128], kind=event["kind"], app=event["app"], source_key=source_key, created_at=utc_now())
            db.add(record)
            try:
                db.flush()
            except IntegrityError:
                db.rollback(); return None
            # A small inbox, independent of terminal history: at most 200/user,
            # with a seven-day upper age limit, cleaned on writes.
            keep = select(TerminalNotification.id).where(TerminalNotification.user_id == user_id).order_by(TerminalNotification.created_at.desc(), TerminalNotification.id.desc()).limit(200)
            db.execute(delete(TerminalNotification).where(TerminalNotification.user_id == user_id,
                (TerminalNotification.id.not_in(keep)) | (TerminalNotification.created_at < utc_now() - timedelta(days=7))))
            return notification_payload(record)

    def subscribe(self, user_id: int, socket) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=128)
        self.subscribers.setdefault(user_id, {})[socket] = queue
        return queue

    def unsubscribe(self, user_id: int, socket):
        subscribers = self.subscribers.get(user_id, {})
        subscribers.pop(socket, None)
        if not subscribers:
            self.subscribers.pop(user_id, None)

    def broadcast(self, user_id: int, message: dict):
        for queue in self.subscribers.get(user_id, {}).values():
            if queue.full():
                queue.get_nowait()
                # The viewer must resynchronize without replaying sounds.
                queue.put_nowait({"type": "resync"})
            else:
                queue.put_nowait(message)

    async def close(self):
        self.closed = True
        if self.cleanup_task:
            self.cleanup_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.cleanup_task
        if self.worker:
            await self.worker
