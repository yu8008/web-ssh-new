from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from app.services.terminal_output import TerminalOutput
from app.services.types import SessionBuffer
from app.api import sessions as sessions_api
from fastapi import WebSocketDisconnect


class Viewer:
    def __init__(self, *, block: bool = False, fail: bool = False) -> None:
        self.messages: list[str] = []
        self.codes: list[int] = []
        self.gate = asyncio.Event()
        if not block:
            self.gate.set()
        self.fail = fail
        self.sending = 0
        self.max_sending = 0

    async def send_text(self, data: str) -> None:
        self.sending += 1
        self.max_sending = max(self.max_sending, self.sending)
        try:
            await self.gate.wait()
            await asyncio.sleep(0)
            if self.fail:
                raise RuntimeError("viewer gone")
            self.messages.append(data)
        finally:
            self.sending -= 1

    async def close(self, *, code: int) -> None:
        assert self.sending == 0
        self.codes.append(code)


async def until(predicate) -> None:
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(0.001)


@pytest.mark.parametrize("framed", [False, True])
def test_replay_and_live_output_share_one_ordered_writer(framed: bool) -> None:
    async def scenario() -> None:
        buffer = SessionBuffer()
        buffer.append("history 中文\r\n")
        output = TerminalOutput(buffer, set())
        viewer = Viewer(block=True)
        subscription = output.subscribe(viewer, framed=framed)
        await until(lambda: viewer.sending == 1)
        output.publish("\x1b[")
        output.publish("31m实时😀\x1b[0m")
        viewer.gate.set()
        await until(lambda: subscription.replayed_at is not None and not subscription.queue)
        await output.close()
        assert viewer.max_sending == 1
        assert viewer.codes == [1000]
        if framed:
            frames = [json.loads(data) for data in viewer.messages]
            assert frames[0] == {"type": "replay_start"}
            end = next(i for i, frame in enumerate(frames) if frame["type"] == "replay_end")
            assert frames[end]["seq"] == 1
            assert "".join(frame["data"] for frame in frames[:end] if frame["type"] == "output") == "history 中文\r\n"
            live = [frame for frame in frames[end + 1:] if frame["type"] == "output"]
            assert "".join(frame["data"] for frame in live) == "\x1b[31m实时😀\x1b[0m"
            assert live[-1]["seq"] == 3
        else:
            assert "".join(viewer.messages) == "history 中文\r\n\x1b[31m实时😀\x1b[0m"
        assert not output.subscriptions
        assert not output.websockets
    asyncio.run(scenario())


def test_live_bursts_are_batched_without_losing_or_reordering_characters() -> None:
    async def scenario() -> None:
        output = TerminalOutput(SessionBuffer(), set())
        viewer = Viewer()
        subscription = output.subscribe(viewer)
        await until(lambda: subscription.replayed_at is not None)
        parts = [f"{index}:中文😀\r\n" for index in range(1000)]
        for part in parts:
            output.publish(part)
        await until(lambda: "".join(viewer.messages) == "".join(parts))
        assert len(viewer.messages) == 1  # The previous path scheduled 1000 sends.
        assert viewer.max_sending == 1
        await output.close()
    asyncio.run(scenario())


def test_a_failed_viewer_does_not_stop_other_viewers_or_replay_storage() -> None:
    async def scenario() -> None:
        output = TerminalOutput(SessionBuffer(), set())
        broken, healthy = Viewer(fail=True), Viewer()
        failed = output.subscribe(broken)
        output.subscribe(healthy)
        output.publish("alive")
        await until(lambda: failed.task.done() and healthy.messages == ["alive"])
        assert broken not in output.websockets
        assert output.buffer.dump()[-1].data == "alive"
        await output.close()
    asyncio.run(scenario())


def test_slow_viewer_queue_is_bounded_even_before_writer_starts() -> None:
    async def scenario() -> None:
        output = TerminalOutput(SessionBuffer(), set(), max_queued_bytes=12)
        viewer = Viewer()
        subscription = output.subscribe(viewer)
        output.publish("中文😀")  # Ten UTF-8 bytes.
        output.publish("more")
        assert subscription.queued_bytes == 0
        await until(lambda: subscription.task.done())
        assert viewer.codes == [1013]
        assert not output.subscriptions
        assert "".join(item.data for item in output.buffer.dump()) == "中文😀more"
    asyncio.run(scenario())


def test_timed_out_sends_release_the_writer() -> None:
    async def scenario() -> None:
        output = TerminalOutput(SessionBuffer(), set(), send_timeout=0.01)
        viewer = Viewer(block=True)
        subscription = output.subscribe(viewer, framed=True)
        await until(lambda: subscription.task.done())
        assert viewer.codes == [1011]
        assert not output.websockets
    asyncio.run(scenario())


def test_session_replacement_transfers_the_writer_and_resets_replay_boundary() -> None:
    async def scenario() -> None:
        old = TerminalOutput(SessionBuffer(), set())
        new = TerminalOutput(SessionBuffer(), set())
        viewer = Viewer()
        subscription = old.subscribe(viewer, framed=True)
        old.publish("old")
        await until(lambda: any('"data": "old"' in message for message in viewer.messages))
        new.publish("new history")
        old.transfer_to(new)
        new.publish("new live")
        await old.close()
        await until(lambda: subscription.replayed_at is not None and not subscription.queue)
        await new.close()
        frames = [json.loads(data) for data in viewer.messages]
        starts = [index for index, frame in enumerate(frames) if frame["type"] == "replay_start"]
        assert len(starts) == 2
        current = frames[starts[-1]:]
        assert "".join(frame["data"] for frame in current if frame["type"] == "output") == "new historynew live"
        assert viewer.max_sending == 1
        assert subscription.owner is new
        assert not old.websockets and not new.websockets
    asyncio.run(scenario())


def test_unsubscribe_cleans_up_a_writer_that_has_not_started() -> None:
    async def scenario() -> None:
        output = TerminalOutput(SessionBuffer(), set())
        viewer = Viewer()
        subscription = output.subscribe(viewer)
        await output.unsubscribe(viewer)
        assert subscription.task.done()
        assert not subscription.queue
        assert not output.subscriptions and not output.websockets
    asyncio.run(scenario())


def test_replacement_discards_superseded_backlog_before_bounded_replay() -> None:
    async def scenario() -> None:
        old = TerminalOutput(SessionBuffer(), set(), max_queued_bytes=20)
        new = TerminalOutput(SessionBuffer(), set(), max_queued_bytes=20)
        viewer = Viewer(block=True)
        subscription = old.subscribe(viewer, framed=True)
        await until(lambda: viewer.sending == 1)
        old.publish("o" * 15)
        new.publish("n" * 15)
        old.transfer_to(new)
        new.publish("live")
        assert subscription.queued_bytes == 19
        viewer.gate.set()
        await until(lambda: subscription.replayed_at is not None and not subscription.queue)
        await new.close()
        assert viewer.codes == [1000]
        frames = [json.loads(message) for message in viewer.messages]
        assert "".join(frame["data"] for frame in frames if frame["type"] == "output") == "n" * 15 + "live"
    asyncio.run(scenario())


def test_history_eviction_preserves_sequence_and_utf8_byte_budget() -> None:
    buffer = SessionBuffer(max_lines=2, max_bytes=10)
    buffer.append("one")
    buffer.append("中文")
    last = buffer.append("😀")
    assert [item.seq for item in buffer.dump()] == [2, 3]
    assert buffer.total_bytes == 10
    assert last.seq == buffer.sequence == 3


@pytest.mark.parametrize("framed", [False, True])
def test_terminal_endpoint_negotiates_output_and_keeps_user_input(monkeypatch, framed: bool) -> None:
    async def scenario() -> None:
        output = TerminalOutput(SessionBuffer(), set())
        output.publish("prompt 中文")
        inputs: list[str] = []

        async def send(data: str) -> None:
            inputs.append(data)

        session = SimpleNamespace(output=output, status="active", channel=object(), send=send)
        record = SimpleNamespace(user_id=1, last_activity=None)
        state = SimpleNamespace(session_manager=SimpleNamespace(get_session=lambda _id: session))
        db = SimpleNamespace(execute=lambda _query: SimpleNamespace(scalar_one_or_none=lambda: record))

        class EndpointViewer(Viewer):
            headers = {"sec-websocket-protocol": "webssh.output.v1" if framed else ""}
            query_params = {"lang": "en-US"}
            accepted = None
            reads = 0

            async def accept(self, *, subprotocol=None):
                self.accepted = subprotocol

            async def receive_text(self):
                self.reads += 1
                await asyncio.sleep(0.01)
                if self.reads == 1:
                    return json.dumps({"type": "input", "data": "\x1b[?1;2cuser"})
                raise WebSocketDisconnect()

        monkeypatch.setattr(sessions_api, "get_current_user_from_ws", lambda *_args: SimpleNamespace(id=1))
        viewer = EndpointViewer()
        await sessions_api.terminal_socket(viewer, "fixture", state, db)
        assert viewer.accepted == ("webssh.output.v1" if framed else None)
        assert inputs == ["user"]
        assert not output.subscriptions and not output.websockets
        if framed:
            frames = [json.loads(message) for message in viewer.messages]
            assert [frame["type"] for frame in frames] == ["replay_start", "output", "replay_end"]
        else:
            assert viewer.messages == ["prompt 中文"]
    asyncio.run(scenario())
