"""One ordered, bounded output writer per terminal viewer."""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from collections import deque

from fastapi import WebSocket

from app.services.types import SessionBuffer, SessionOutput

OUTPUT_PROTOCOL = "webssh.output.v1"
FLOW_PROTOCOL = "webssh.output.v2"
logger = logging.getLogger(__name__)


class TerminalOutputSubscription:
    def __init__(self, owner: TerminalOutput, websocket: WebSocket, framed: bool) -> None:
        self.owner = owner
        self.websocket = websocket
        self.framed = framed
        self.queue: deque[SessionOutput | dict] = deque()
        self.queued_bytes = 0
        self.wake = asyncio.Event()
        self.accepting = True
        self.close_code = 1000
        self.replayed_at: float | None = None
        self.pending_pong: int | None = None
        self.pong_details: dict | None = None
        self.pong_started = 0.0
        self.flow_control = False
        self.inflight: deque[tuple[int, int]] = deque()
        self.inflight_chars = 0
        self.last_sent_seq = 0
        self.replay(owner.buffer)
        self.task = asyncio.create_task(self._run())

    def replay(self, buffer: SessionBuffer) -> None:
        # No await between snapshot and registration: live data can only follow
        # this boundary, even when sending the history takes several seconds.
        self.queue.append({"type": "replay_start"})
        for output in buffer.dump():
            self.queue.append(output)
            self.queued_bytes += output.byte_size
            if self.queued_bytes > self.owner.max_queued_bytes:
                self._overflow()
                return
        self.queue.append({"type": "replay_end", "seq": buffer.sequence})
        self.replayed_at = None
        self.wake.set()

    def enqueue(self, output: SessionOutput) -> None:
        if not self.accepting:
            return
        self.queued_bytes += output.byte_size
        if self.queued_bytes > self.owner.max_queued_bytes:
            # Disconnect explicitly; never silently skip bytes in an ANSI stream.
            self._overflow()
            return
        self.queue.append(output)
        self.wake.set()

    def pong(self, ping_id: int, details: dict | None = None) -> None:
        # Keep one control response, owned by the same writer as output. A slow
        # viewer must not build an unbounded queue of latency probes.
        if self.accepting and self.framed:
            self.pending_pong = ping_id
            self.pong_details = details
            self.pong_started = time.monotonic()
            self.wake.set()

    def enable_flow_control(self) -> None:
        if self.framed:
            self.flow_control = True
            self.wake.set()

    def acknowledge(self, seq: int, epoch: str | None) -> None:
        if not self.flow_control or epoch != self.owner.epoch or seq > self.last_sent_seq:
            return
        while self.inflight and self.inflight[0][0] <= seq:
            self.inflight_chars -= self.inflight.popleft()[1]
        self.wake.set()

    def reset_flow_control(self) -> None:
        self.inflight.clear()
        self.inflight_chars = self.last_sent_seq = 0
        self.wake.set()

    def _overflow(self) -> None:
        self.close_code = 1013
        self.accepting = False
        self.queue.clear()
        self.queued_bytes = 0
        self.pending_pong = None
        self.wake.set()

    def finish(self) -> None:
        self.accepting = False
        self.wake.set()

    async def close(self) -> None:
        self.finish()
        try:
            await asyncio.wait_for(asyncio.shield(self.task), timeout=1)
        except asyncio.TimeoutError:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)

    async def _run(self) -> None:
        try:
            while self.queue or self.pending_pong is not None or self.accepting:
                blocked = self.flow_control and self.inflight_chars >= self.owner.window_chars
                if self.pending_pong is None and (not self.queue or blocked):
                    if not self.accepting and not self.queue:
                        break
                    self.wake.clear()
                    await self.wake.wait()
                    if self.pending_pong is None and (not self.queue or (self.flow_control and self.inflight_chars >= self.owner.window_chars)):
                        continue
                    # Give ready SSH callbacks a turn to coalesce a live burst.
                    # The default yields without a fixed delay on each echo.
                    if self.replayed_at is not None and self.pending_pong is None:
                        await asyncio.sleep(self.owner.batch_delay)
                if self.pending_pong is not None:
                    ping_id, self.pending_pong = self.pending_pong, None
                    reply = {"type": "pong", "ping_id": ping_id}
                    if self.pong_details is not None:
                        reply.update(self.pong_details)
                        reply["gateway_queue_ms"] = round(max(0, time.monotonic() - self.pong_started) * 1000, 1)
                        reply["gateway_queued_chars"] = sum(len(item.data) for item in self.queue if isinstance(item, SessionOutput))
                        reply["gateway_inflight_chars"] = self.inflight_chars
                    self.pong_details = None
                    await self._send(json.dumps(reply))
                    continue
                item = self.queue.popleft()
                if isinstance(item, dict):
                    if self.framed:
                        await self._send(json.dumps(item))
                    if item["type"] == "replay_end":
                        self.replayed_at = asyncio.get_running_loop().time()
                    continue
                parts = [item.data]
                size = len(item.data)
                self.queued_bytes -= item.byte_size
                seq = item.seq
                limit = min(self.owner.batch_chars, max(1, self.owner.window_chars - self.inflight_chars)) if self.flow_control else self.owner.batch_chars
                while self.queue and isinstance(self.queue[0], SessionOutput):
                    following = self.queue[0]
                    if size + len(following.data) > limit:
                        break
                    self.queue.popleft()
                    parts.append(following.data)
                    size += len(following.data)
                    self.queued_bytes -= following.byte_size
                    seq = following.seq
                data = "".join(parts)
                if self.framed:
                    frame = {"type": "output", "seq": seq, "data": data}
                    if self.flow_control:
                        frame["epoch"] = self.owner.epoch
                        self.inflight.append((seq, size))
                        self.inflight_chars += size
                        self.last_sent_seq = seq
                    data = json.dumps(frame, ensure_ascii=False)
                await self._send(data)
        except asyncio.CancelledError:
            pass
        except Exception:
            if self.close_code != 1013:
                self.close_code = 1011
            logger.debug("Terminal output writer stopped", exc_info=True)
        finally:
            self.accepting = False
            self.queue.clear()
            self.queued_bytes = 0
            self.pending_pong = None
            self.reset_flow_control()
            self.owner.detach(self)
            try:
                await asyncio.wait_for(self.websocket.close(code=self.close_code), timeout=1)
            except Exception:
                pass

    async def _send(self, data: str) -> None:
        await asyncio.wait_for(self.websocket.send_text(data), timeout=self.owner.send_timeout)


class TerminalOutput:
    def __init__(
        self, buffer: SessionBuffer, websockets: set[WebSocket], *,
        batch_delay: float = 0, batch_chars: int = 64 * 1024,
        max_queued_bytes: int = 16 * 1024 * 1024, send_timeout: float = 10,
        window_chars: int = 64 * 1024,
    ) -> None:
        self.buffer = buffer
        self.websockets = websockets
        self.subscriptions: dict[WebSocket, TerminalOutputSubscription] = {}
        self.batch_delay = batch_delay
        self.epoch = secrets.token_hex(8)
        self.window_chars = max(1, window_chars)
        self.batch_chars = batch_chars
        self.max_queued_bytes = max_queued_bytes
        self.send_timeout = send_timeout

    def subscribe(self, websocket: WebSocket, *, framed: bool = False) -> TerminalOutputSubscription:
        subscription = TerminalOutputSubscription(self, websocket, framed)
        self.subscriptions[websocket] = subscription
        self.websockets.add(websocket)
        return subscription

    def publish(self, data: str) -> None:
        if not data:
            return
        output = self.buffer.append(data)
        for subscription in tuple(self.subscriptions.values()):
            subscription.enqueue(output)

    def detach(self, subscription: TerminalOutputSubscription) -> None:
        if self.subscriptions.get(subscription.websocket) is subscription:
            self.subscriptions.pop(subscription.websocket, None)
            self.websockets.discard(subscription.websocket)

    async def unsubscribe(self, websocket: WebSocket) -> None:
        subscription = self.subscriptions.get(websocket)
        if subscription:
            # The viewer is already gone; do not wait for its pending history.
            self.detach(subscription)
            subscription.task.cancel()
            await asyncio.gather(subscription.task, return_exceptions=True)
            subscription.queue.clear()
            subscription.queued_bytes = 0
        self.websockets.discard(websocket)

    def transfer_to(self, target: TerminalOutput) -> None:
        for websocket, subscription in tuple(self.subscriptions.items()):
            self.detach(subscription)
            subscription.owner = target
            subscription.reset_flow_control()
            target.subscriptions[websocket] = subscription
            target.websockets.add(websocket)
            if subscription.framed:
                # The reset boundary supersedes the old stream. An in-flight
                # send still completes before the new replay starts.
                subscription.queue.clear()
                subscription.queued_bytes = 0
            subscription.replay(target.buffer)

    def finish(self) -> None:
        for subscription in tuple(self.subscriptions.values()):
            subscription.finish()

    async def close(self) -> None:
        await asyncio.gather(*(sub.close() for sub in tuple(self.subscriptions.values())))
