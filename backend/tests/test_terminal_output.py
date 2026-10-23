from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from app.services.terminal_output import TerminalOutput
from app.services.types import SessionBuffer
from app.api import sessions as sessions_api
from fastapi import WebSocket, WebSocketDisconnect


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


def test_replay_restores_paste_mode_when_enable_has_aged_out_and_live_output_follows():
    async def scenario():
        buffer = SessionBuffer(max_lines=2)
        buffer.append("\x1b[?2004h")
        buffer.append("Old output\r\n")
        buffer.append("Recent output\r\n")
        assert all("2004" not in item.data for item in buffer.dump())
        output = TerminalOutput(buffer, set())
        viewer = Viewer(block=True)
        subscription = output.subscribe(viewer, framed=True)
        # A CLI exit during a slow replay must follow the captured mode, not
        # retroactively change the snapshot or leave the next shell in paste mode.
        output.publish("\x1b[?2004l")
        viewer.gate.set()
        await until(lambda: subscription.replayed_at is not None and not subscription.queue)
        await output.close()
        frames = [json.loads(data) for data in viewer.messages]
        end = next(i for i, frame in enumerate(frames) if frame["type"] == "replay_end")
        assert frames[end] == {"type": "replay_end", "seq": 3, "bracketed_paste": True}
        assert frames[end + 1]["data"] == "\x1b[?2004l"
        assert not buffer.modes.bracketed_paste
    asyncio.run(scenario())


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


def test_live_echo_does_not_wait_for_a_fixed_batch_window(monkeypatch) -> None:
    async def scenario() -> None:
        output = TerminalOutput(SessionBuffer(), set())
        echoed = asyncio.Event()

        class EchoViewer(Viewer):
            async def send_text(self, data: str) -> None:
                await super().send_text(data)
                if data == "echo":
                    echoed.set()

        viewer = EchoViewer()
        subscription = output.subscribe(viewer)
        await until(lambda: subscription.replayed_at is not None)
        requested_delays = []
        original_sleep = asyncio.sleep

        async def record_sleep(delay):
            requested_delays.append(delay)
            await original_sleep(0)

        monkeypatch.setattr(asyncio, "sleep", record_sleep)
        output.publish("echo")
        await asyncio.wait_for(echoed.wait(), timeout=1)
        assert not any(delay > 0 for delay in requested_delays)
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


@pytest.mark.parametrize("framed", [False, True, "flow"])
def test_terminal_endpoint_negotiates_output_and_keeps_user_input(monkeypatch, framed) -> None:
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
            headers = {"sec-websocket-protocol": "webssh.output.v2, webssh.output.v1" if framed == "flow" else "webssh.output.v1" if framed else ""}
            query_params = {"lang": "en-US"}
            accepted = None
            reads = 0

            async def accept(self, *, subprotocol=None):
                self.accepted = subprotocol

            async def receive_text(self):
                self.reads += 1
                await asyncio.sleep(0.01)
                if self.reads == 1:
                    return json.dumps({"type": "ping", "ping_id": 7})
                if self.reads == 2:
                    return json.dumps({"type": "input", "data": "\x1b[?1;2cuser"})
                raise WebSocketDisconnect()

        monkeypatch.setattr(sessions_api, "get_current_user_from_ws", lambda *_args: SimpleNamespace(id=1))
        viewer = EndpointViewer()
        await sessions_api.terminal_socket(viewer, "fixture", state, db)
        assert viewer.accepted == ("webssh.output.v2" if framed == "flow" else "webssh.output.v1" if framed else None)
        assert inputs == ["user"]
        assert not output.subscriptions and not output.websockets
        if framed:
            frames = [json.loads(message) for message in viewer.messages]
            assert [frame["type"] for frame in frames if frame["type"] != "pong"] == ["replay_start", "output", "replay_end"]
            assert [frame for frame in frames if frame["type"] == "pong"] == [{"type": "pong", "ping_id": 7}]
            if framed == "flow":
                assert next(frame for frame in frames if frame["type"] == "output")["epoch"] == output.epoch
        else:
            assert viewer.messages == ["prompt 中文"]
    asyncio.run(scenario())


def test_latency_pongs_are_bounded_and_share_the_output_writer() -> None:
    async def scenario() -> None:
        output = TerminalOutput(SessionBuffer(), set())
        viewer = Viewer(block=True)
        subscription = output.subscribe(viewer, framed=True)
        await until(lambda: viewer.sending == 1)
        output.publish("before")
        for ping_id in range(1000):
            subscription.pong(ping_id)
        output.publish("after")
        assert subscription.pending_pong == 999
        assert len(subscription.queue) == 3  # Replay end and two output chunks.
        viewer.gate.set()
        await until(lambda: subscription.pending_pong is None and not subscription.queue)
        await output.close()
        frames = [json.loads(message) for message in viewer.messages]
        assert [frame for frame in frames if frame["type"] == "pong"] == [{"type": "pong", "ping_id": 999}]
        assert "".join(frame["data"] for frame in frames if frame["type"] == "output") == "beforeafter"
        assert viewer.max_sending == 1

    asyncio.run(scenario())


def test_flow_control_bounds_unparsed_output_and_pongs_bypass_the_window() -> None:
    async def scenario() -> None:
        output = TerminalOutput(SessionBuffer(), set(), batch_chars=4, window_chars=4)
        viewer = Viewer()
        subscription = output.subscribe(viewer, framed=True)
        subscription.enable_flow_control()
        await until(lambda: subscription.replayed_at is not None)
        for text in ["一二", "三四", "五六", "七八"]:
            output.publish(text)
        await until(lambda: subscription.inflight_chars == 4)
        frames = [json.loads(message) for message in viewer.messages]
        sent = [frame for frame in frames if frame["type"] == "output"]
        assert "".join(frame["data"] for frame in sent) == "一二三四"
        assert sent[-1]["epoch"] == output.epoch
        subscription.pong(1, {"gateway_loop_lag_ms": 3})
        await until(lambda: any('"type": "pong"' in message for message in viewer.messages))
        pong = next(json.loads(message) for message in viewer.messages if '"type": "pong"' in message)
        assert pong["gateway_inflight_chars"] == 4
        assert pong["gateway_queued_chars"] == 4
        assert pong["gateway_queue_ms"] >= 0
        assert pong["gateway_loop_lag_ms"] == 3
        subscription.acknowledge(999, output.epoch)
        subscription.acknowledge(sent[-1]["seq"], "stale stream")
        assert subscription.inflight_chars == 4
        subscription.acknowledge(sent[-1]["seq"], output.epoch)
        await until(lambda: not subscription.queue)
        assert "".join(json.loads(message).get("data", "") for message in viewer.messages) == "一二三四五六七八"
        subscription.acknowledge(subscription.last_sent_seq, output.epoch)
        subscription.acknowledge(subscription.last_sent_seq, output.epoch)
        assert subscription.inflight_chars == 0
        await output.close()
    asyncio.run(scenario())


def test_flow_ack_from_a_replaced_stream_cannot_release_current_output() -> None:
    async def scenario() -> None:
        old = TerminalOutput(SessionBuffer(), set(), window_chars=4)
        new = TerminalOutput(SessionBuffer(), set(), window_chars=4)
        viewer = Viewer()
        subscription = old.subscribe(viewer, framed=True)
        subscription.enable_flow_control()
        old.publish("old!")
        await until(lambda: subscription.inflight_chars == 4)
        new.publish("new!")
        old.transfer_to(new)
        await until(lambda: subscription.inflight_chars == 4)
        subscription.acknowledge(1, old.epoch)
        assert subscription.inflight_chars == 4
        subscription.acknowledge(1, new.epoch)
        await until(lambda: subscription.replayed_at is not None)
        await old.close()
        await new.close()
        assert subscription.inflight_chars == 0
    asyncio.run(scenario())


def test_websocket_transport_replays_with_acknowledgements_while_input_remains_available(monkeypatch) -> None:
    from threading import Timer
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    inputs = []
    expected = "".join(f"{index}:" + "中文😀" * 10922 for index in range(4))

    @app.websocket("/terminal")
    async def endpoint(websocket: WebSocket):
        output = TerminalOutput(SessionBuffer(), set())
        for index in range(4):
            output.publish(f"{index}:" + "中文😀" * 10922)

        async def send(data):
            inputs.append(data)

        session = SimpleNamespace(output=output, status="active", channel=object(), send=send)
        state = SimpleNamespace(session_manager=SimpleNamespace(get_session=lambda _id: session))
        record = SimpleNamespace(user_id=1, last_activity=None)
        db = SimpleNamespace(execute=lambda _query: SimpleNamespace(scalar_one_or_none=lambda: record))
        await sessions_api.terminal_socket(websocket, "transport", state, db)

    monkeypatch.setattr(sessions_api, "get_current_user_from_ws", lambda *_args: SimpleNamespace(id=1))
    with TestClient(app) as client, client.websocket_connect("/terminal", subprotocols=["webssh.output.v2", "webssh.output.v1"]) as socket:
        deadline = Timer(5, socket.close)
        deadline.start()
        try:
            assert socket.accepted_subprotocol == "webssh.output.v2"
            assert socket.receive_json()["type"] == "replay_start"
            first = socket.receive_json()
            assert first["type"] == "output" and first["seq"] == 2
            received = first["data"]
            # The next history window cannot be sent until the browser parses
            # this one, but the terminal receive loop must still accept input.
            socket.send_json({"type": "input", "data": "key while history is paused"})
            socket.send_json({"type": "ping", "ping_id": 8, "diagnostics": True})
            pong = socket.receive_json()
            assert pong["type"] == "pong" and pong["gateway_inflight_chars"] >= 60000
            assert inputs == ["key while history is paused"]
            socket.send_json({"type": "ack", "ack_seq": first["seq"], "epoch": first["epoch"]})
            while True:
                frame = socket.receive_json()
                if frame["type"] == "replay_end":
                    break
                assert frame["type"] == "output"
                received += frame["data"]
                socket.send_json({"type": "ack", "ack_seq": frame["seq"], "epoch": frame["epoch"]})
            assert received == expected
        finally:
            deadline.cancel()


def test_terminal_input_does_not_wait_for_resize_and_latest_size_wins(monkeypatch) -> None:
    async def scenario() -> None:
        output = TerminalOutput(SessionBuffer(), set())
        resize_started = asyncio.Event()
        release_resize = asyncio.Event()
        final_resize = asyncio.Event()
        input_received = asyncio.Event()
        disconnect = asyncio.Event()
        sizes = []

        async def resize(rows, cols):
            sizes.append((rows, cols))
            resize_started.set()
            await release_resize.wait()
            if (rows, cols) == (32, 120):
                final_resize.set()

        async def send(data):
            assert data == "typed while resizing"
            input_received.set()

        session = SimpleNamespace(output=output, status="active", channel=object(), send=send, resize=resize)
        record = SimpleNamespace(user_id=1, last_activity=None, pty_info='{"term":"xterm-256color","rows":24,"cols":80}')
        manager = SimpleNamespace(
            get_session=lambda _id: session,
            deserialize_pty=lambda data: SimpleNamespace(**json.loads(data)),
            serialize_pty=lambda pty: json.dumps(vars(pty)),
        )
        state = SimpleNamespace(session_manager=manager)
        db = SimpleNamespace(execute=lambda _query: SimpleNamespace(scalar_one_or_none=lambda: record))

        class ResizingViewer(Viewer):
            headers = {"sec-websocket-protocol": "webssh.output.v1"}
            query_params = {"lang": "en-US"}
            reads = 0

            async def accept(self, *, subprotocol=None):
                pass

            async def receive_text(self):
                self.reads += 1
                await asyncio.sleep(0)
                if self.reads == 1:
                    return json.dumps({"type": "resize", "rows": 30, "cols": 80})
                if self.reads == 2:
                    await resize_started.wait()
                    return json.dumps({"type": "resize", "rows": 31, "cols": 100})
                if self.reads == 3:
                    return json.dumps({"type": "resize", "rows": 32, "cols": 120})
                if self.reads == 4:
                    return json.dumps({"type": "input", "data": "typed while resizing"})
                await disconnect.wait()
                raise WebSocketDisconnect()

        monkeypatch.setattr(sessions_api, "get_current_user_from_ws", lambda *_args: SimpleNamespace(id=1))
        endpoint = asyncio.create_task(sessions_api.terminal_socket(ResizingViewer(), "fixture", state, db))
        try:
            await asyncio.wait_for(resize_started.wait(), 1)
            await asyncio.wait_for(input_received.wait(), .5)
            assert not release_resize.is_set()
            release_resize.set()
            await asyncio.wait_for(final_resize.wait(), 1)
            assert sizes == [(30, 80), (32, 120)]
            await asyncio.sleep(0)
            assert json.loads(record.pty_info) == {"term": "xterm-256color", "rows": 32, "cols": 120}
        finally:
            release_resize.set()
            disconnect.set()
            await asyncio.wait_for(endpoint, 2)

    asyncio.run(scenario())
