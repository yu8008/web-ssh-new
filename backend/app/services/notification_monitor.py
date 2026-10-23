"""Own a separate, cancellable SSH channel for live CLI notification metadata."""
from __future__ import annotations

import asyncio
import base64
from contextlib import suppress
import json
from pathlib import Path
import shlex


def runtime_command(session, action="watch", **extra):
    source = base64.b64encode(Path(__file__).with_name("notification_runtime.py").read_bytes()).decode()
    options = {"action": action, "key": session.enhanced_fingerprint or session.session_id, **extra}
    if session.enhanced_enabled:
        options.update({"tmux": session.tmux_binary_path, "target": f"{session.enhanced_fingerprint}:0.0"})
    runner = "import base64;exec(compile(base64.b64decode(" + repr(source) + "),'<webssh-notification-runtime>','exec'))"
    return f"python3 -u -c {shlex.quote(runner)} {shlex.quote(json.dumps(options))}"


async def probe_runtime(session):
    result = await session.client.run(runtime_command(session, "probe"), check=False, timeout=15)
    try:
        status = json.loads(str(result.stdout).strip())
        if result.exit_status or not isinstance(status, dict) or not isinstance(status.get("state"), str):
            raise ValueError()
        return status
    except (ValueError, TypeError):
        return {"state": "unavailable", "capabilities": {}, "candidates": []}


class NotificationMonitor:
    def __init__(self, session, on_event, on_status=None):
        self.session = session
        self.on_event = on_event
        self.on_status = on_status
        self.runtime = {"state": "pending", "capabilities": {}, "candidates": []}
        self.verified: dict[str, set[str]] = {}
        self.process = None
        self.task = None
        self.ready = asyncio.Event()
        self.lock = asyncio.Lock()

    def publish(self):
        if self.on_status:
            self.on_status(self.session.user_id, {"type": "notification_runtime", "session_id": self.session.session_id, "runtime": self.snapshot()})

    def snapshot(self):
        result = {**self.runtime, "capabilities": dict(self.runtime.get("capabilities", {}))}
        for kind in self.verified.get(result.get("app"), set()):
            result["capabilities"][kind] = "verified"
        return result

    def native(self, event):
        app = event.get("app")
        if app in {"codex", "claude"}:
            verified = self.verified.setdefault(app, set())
            if event["kind"] not in verified:
                verified.add(event["kind"]); self.publish()
        # A bound rollout supplies a stable turn ID and works with old TUIs.
        # Prefer it so the same turn cannot ring twice through OSC and JSONL.
        if app == "codex" and event.get("kind") == "complete" and self.runtime.get("state") == "attached":
            return
        self.on_event(self.session.user_id, self.session.session_id, event)

    def start(self):
        if self.task is None or self.task.done():
            self.ready.clear()
            self.task = asyncio.create_task(self.run())

    async def run(self):
        process = None
        try:
            process = await self.session.client.create_process(runtime_command(self.session), encoding="utf-8")
            self.process = process
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                if len(line) > 65536:
                    continue
                try:
                    payload = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if payload.get("type") == "status" and isinstance(payload.get("runtime"), dict):
                    runtime = payload["runtime"]
                    if (runtime.get("identity"), runtime.get("binding")) != (self.runtime.get("identity"), self.runtime.get("binding")):
                        self.verified.clear()
                    self.runtime = runtime
                    self.ready.set(); self.publish()
                elif payload.get("type") == "event":
                    event = payload.get("event", {})
                    if self.runtime.get("state") != "attached" or event.get("app") != "codex" or event.get("kind") != "complete" or not isinstance(event.get("id"), str):
                        continue
                    self.verified.setdefault("codex", set()).add("complete")
                    self.on_event(self.session.user_id, self.session.session_id, event)
                    self.publish()
        except asyncio.CancelledError:
            raise
        except Exception:
            # This auxiliary channel must never affect terminal input/output.
            pass
        finally:
            if process:
                with suppress(Exception):
                    process.stdin.write_eof()
                with suppress(Exception):
                    process.close()
            self.process = None
            if self.runtime.get("state") != "unavailable":
                self.runtime = {"state": "disconnected", "capabilities": {}, "candidates": []}
            self.ready.set(); self.publish()

    async def close(self):
        async with self.lock:
            await self._close()

    async def _close(self):
        task = self.task
        if task and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        self.task = None

    async def restart(self):
        async with self.lock:
            await self._close()
            self.start()
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.ready.wait(), 5)
