from __future__ import annotations

import asyncio
from datetime import timedelta
import json
from types import SimpleNamespace
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from app.api import notifications as api
from app.api.dependencies import get_current_user, get_db, get_state
from app.core.db import Database, utc_now
from app.models.connection import Connection
from app.models.user import User
from app.models.session import SessionRecord
from app.models.notification import TerminalNotification
from app.services.terminal_notifications import NotificationService, TerminalNotificationParser
from app.services.notification_setup import configure_tmux_relay
from app.services import notification_agent as agent


def osc(value, end="\x07"):
    return "\x1b]" + value + end


START = osc("7501;state=working:app=codex", "\x1b\\")
IDLE = osc("7501;state=idle:app=codex", "\x1b\\")
BLOCKED = osc("7501;state=blocked:app=codex", "\x1b\\")
CLAUDE = osc('777;notify;WebSSH Gateway;{"kind":"question","app":"claude","id":"request-1"}')


@pytest.mark.parametrize("stream,expected", [
    (START + osc("9;Probe finished successfully.") + IDLE, [{"kind": "complete", "app": "codex"}]),
    (START + BLOCKED + osc("9;Question: Pick an option?"), [{"kind": "attention", "app": "codex"}]),
    (START + osc("9;Approval requested: printf probe") + BLOCKED, [{"kind": "attention", "app": "codex"}]),
    (START + osc("9;Question: this is part of a completed answer") + IDLE, [{"kind": "complete", "app": "codex"}]),
    (CLAUDE, [{"kind": "question", "app": "claude", "id": "request-1"}]),
    (osc("0;title") + osc("8;;https://example.com") + osc("11;?"), []),
    ("Task complete? Allow this command?\nWaiting...", []),
    ("\x1bPopaque\x07" + CLAUDE + "\x1b\\", []),
    (osc("9;4;1;25"), []),
    (osc("777;notify;Other app;message") + "\x07", [{"kind": "bell", "app": "terminal"}, {"kind": "bell", "app": "terminal"}]),
])
def test_control_sequences_at_every_chunk_boundary(stream, expected):
    for split in range(len(stream) + 1):
        parser = TerminalNotificationParser()
        assert parser.feed(stream[:split]) + parser.feed(stream[split:]) == expected, split
    parser = TerminalNotificationParser()
    assert [event for char in stream for event in parser.feed(char)] == expected


def test_malformed_and_oversized_strings_are_bounded():
    parser = TerminalNotificationParser()
    assert parser.feed(osc("777;" + "x" * 100000)) == []
    assert len(parser.pending) <= 4096
    for value in ['{"kind":"question","app":"evil"}', '{"kind":"execute","app":"claude"}', '[]', 'not-json']:
        assert parser.feed(osc("777;notify;WebSSH Gateway;" + value)) == []
    assert parser.feed(CLAUDE)[0]["kind"] == "question"


def test_attaching_during_a_running_turn_accepts_the_first_explicit_waiting_state():
    parser = TerminalNotificationParser()
    assert parser.feed(BLOCKED) == [{"kind": "attention", "app": "codex"}]
    assert parser.feed(BLOCKED + osc("9;Waiting for input")) == []
    parser.feed(START)
    assert parser.feed(BLOCKED) == [{"kind": "attention", "app": "codex"}]


def test_claude_native_completion_waits_until_after_stop_hooks_and_ignores_children():
    parser = TerminalNotificationParser()
    assert "reply" in parser.feed(osc("7501;?"))[0]
    assert parser.feed(osc("7501;state=working:app=claude-code")) == []
    candidate = osc('777;notify;WebSSH Gateway;{"kind":"complete","app":"claude"}')
    assert parser.feed(candidate) == []
    assert parser.feed(osc("7501;state=done:id=child:app=claude-code")) == []
    assert parser.feed(osc("7501;state=working:app=claude-code") + candidate) == []
    assert parser.feed(osc("7501;state=done:app=claude-code")) == [{"kind": "complete", "app": "claude"}]
    assert parser.feed(osc("7501;state=done:app=claude-code")) == []


def test_claude_hook_and_waiting_state_only_alert_once_and_errors_are_not_completions():
    parser = TerminalNotificationParser()
    parser.feed(osc("7501;state=working:app=claude-code"))
    assert parser.feed(CLAUDE)[0]["kind"] == "question"
    assert parser.feed(osc("7501;state=waiting:app=claude-code")) == []
    assert parser.feed(CLAUDE) == []
    parser.feed(osc("7501;state=working:app=claude-code"))
    assert parser.feed(osc("7501;state=error:app=claude-code")) == [{"kind": "attention", "app": "claude"}]


@pytest.fixture
def database(tmp_path):
    database = Database(f"sqlite:///{tmp_path / 'notifications.db'}")
    database.create_tables()
    with database.session() as db:
        db.add_all([User(id=1, username="one", password_hash="unused"), User(id=2, username="two", password_hash="unused")])
        db.flush()
        db.add(Connection(id=1, user_id=1, name="Target server", host="example.test", port=22, username="test", auth_type="password", auth_data="unused"))
        db.flush()
        db.add_all([SessionRecord(id="one", user_id=1, connection_id=1, status="active", started_at=utc_now(), last_activity=utc_now(), pty_info="{}", title="Repository"),
                    SessionRecord(id="two", user_id=2, connection_id=1, status="active", started_at=utc_now(), last_activity=utc_now(), pty_info="{}")])
    return database


def test_worker_records_once_and_routes_by_owner(database):
    async def scenario():
        service = NotificationService(database)
        one, two = object(), object()
        queue = service.subscribe(1, one); other = service.subscribe(2, two)
        service.observe(1, "one", {"kind": "question", "app": "claude", "id": "request-1"})
        service.observe(1, "one", {"kind": "question", "app": "claude", "id": "request-1"})
        service.observe(2, "one", {"kind": "complete", "app": "codex"})
        await service.close()
        assert queue.qsize() == 1 and other.empty()
        assert queue.get_nowait()["event"]["session_name"] == "Repository"
        with database.session() as db:
            assert len(api.inbox(db, 1)) == 1 and api.inbox(db, 2) == []
        service.unsubscribe(1, one); service.unsubscribe(2, two)
        assert not service.subscribers
    asyncio.run(scenario())


def test_retention_and_slow_viewers_are_bounded(database):
    service = NotificationService(database)
    with database.session() as db:
        db.add_all([TerminalNotification(id=f"old-{index}", user_id=1, session_id="one", session_name="Old", kind="complete", app="codex", created_at=utc_now() - timedelta(days=8 if index == 0 else 1)) for index in range(205)])
    for index in range(2):
        service._store(1, "one", {"kind": "complete", "app": "codex", "id": f"new-{index}"})
    with database.session() as db:
        records = db.scalars(select(TerminalNotification)).all()
        assert len(records) == 200 and not any(record.id == "old-0" for record in records)
    queue = service.subscribe(1, object())
    for _ in range(300): service.broadcast(1, {"type": "notification"})
    assert queue.qsize() <= 128
    assert any(queue.get_nowait()["type"] == "resync" for _ in range(queue.qsize()))


def test_inbox_and_read_are_user_scoped(database):
    service = NotificationService(database)
    item = service._store(1, "one", {"kind": "complete", "app": "codex"})
    app = FastAPI(); app.include_router(api.router)
    app.dependency_overrides[get_state] = lambda: SimpleNamespace(database=database, notifications=service)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=1)
    def db_override():
        with database.session() as db: yield db
    app.dependency_overrides[get_db] = db_override
    queue = service.subscribe(1, object())
    with TestClient(app) as client:
        assert client.get("/notifications").json()[0]["id"] == item["id"]
        assert client.patch(f"/notifications/{item['id']}/read").json()["read_at"]
        assert queue.get_nowait()["type"] == "read"
        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=2)
        assert client.get("/notifications").json() == []
        assert client.patch(f"/notifications/{item['id']}/read").status_code == 404


def test_websocket_auth_snapshot_live_delivery_and_cross_device_read(database):
    from starlette.websockets import WebSocketDisconnect
    service = NotificationService(database)
    existing = service._store(1, "one", {"kind": "complete", "app": "codex"})
    app = FastAPI(); app.include_router(api.router)
    state = SimpleNamespace(database=database, notifications=service, auth_service=SimpleNamespace(decode_token=lambda value: {"sub": int(value)}))
    app.dependency_overrides[get_state] = lambda: state
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=1)
    def db_override():
        with database.session() as db: yield db
    app.dependency_overrides[get_db] = db_override
    @app.post("/emit-test-event")
    async def emit():
        service.observe(1, "one", {"kind": "question", "app": "claude", "id": "live-question"})
        await service.queue.join()
        return {}
    with TestClient(app) as client:
        protocols = ["webssh.notifications.v1", "bearer.1"]
        with client.websocket_connect("/notifications/ws", subprotocols=protocols) as one:
            assert one.receive_json()["events"][0]["id"] == existing["id"]
            one.send_text("ping")
            assert one.receive_json() == {"type": "pong"}
            with client.websocket_connect("/notifications/ws", subprotocols=protocols) as two:
                assert two.receive_json()["type"] == "snapshot"
                assert client.post("/emit-test-event").status_code == 200
                first = one.receive_json(); second = two.receive_json()
                assert first == second and first["type"] == "notification"
                assert client.patch(f"/notifications/{first['event']['id']}/read").status_code == 200
                assert one.receive_json()["type"] == "read"
                assert two.receive_json()["type"] == "read"
        with client.websocket_connect("/notifications/ws", subprotocols=["webssh.notifications.v1", "bearer.2"]) as other:
            assert other.receive_json() == {"type": "snapshot", "events": []}
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/notifications/ws", subprotocols=["webssh.notifications.v1", "bearer.invalid"]) as invalid:
                invalid.receive_json()
    assert not service.subscribers


@pytest.mark.parametrize("original", ["", '# Keep comment\n[tui]\nnotifications = false # old\nfoo = "keep"\n[other]\nkey = 1\n', '[tui]\nnotifications = [\n "old-event",\n]\nnotification_method="bel"\n', 'tui.foo="keep"\ntui.notifications=false\n[other]\nkey=1\n'])
def test_codex_config_edit_preserves_and_restores(original):
    import tomllib
    old = tomllib.loads(original)
    changed = agent.edit_tui(original, agent.TUI)
    assert tomllib.loads(changed)["tui"] | agent.TUI == tomllib.loads(changed)["tui"]
    if '# Keep comment' in original: assert '# Keep comment' in changed
    if "foo" in old.get("tui", {}): assert tomllib.loads(changed)["tui"]["foo"] == "keep"
    restored = agent.edit_tui(changed, {key: old.get("tui", {}).get(key) for key in agent.TUI})
    assert tomllib.loads(restored).get("tui", {}) == old.get("tui", {})


def test_install_undo_preserves_user_hooks_and_later_edits(tmp_path, monkeypatch):
    root = tmp_path / "agent"; codex = tmp_path / "codex" / "config.toml"; claude = tmp_path / "claude" / "settings.json"
    codex.parent.mkdir(); claude.parent.mkdir()
    codex.write_text('model="keep"\n[tui]\nnotifications=false\n')
    user_hook = {"matcher": "Bash", "hooks": [{"type": "command", "command": "keep-user-hook"}]}
    claude.write_text(json.dumps({"theme": "light", "hooks": {"PreToolUse": [user_hook]}}))
    monkeypatch.setattr(agent, "paths", lambda: (root, codex, claude))
    monkeypatch.setattr(agent, "version", lambda command: "0.163.0" if command == "codex" else "2.1.306")
    agent.configure("install"); agent.configure("install")
    config = json.loads(claude.read_text())
    assert config["hooks"]["PreToolUse"][0] == user_hook and len(config["hooks"]["PreToolUse"]) == 2
    config["added_later"] = True; claude.write_text(json.dumps(config))
    codex.write_text(codex.read_text().replace('notification_method = "osc9"', 'notification_method = "auto"'))
    agent.configure("uninstall")
    import tomllib
    assert tomllib.loads(codex.read_text()) == {"model": "keep", "tui": {"notifications": False, "notification_method": "auto"}}
    config = json.loads(claude.read_text())
    assert config["theme"] == "light" and config["added_later"] and config["hooks"]["PreToolUse"] == [user_hook]


@pytest.mark.parametrize("payload,kind", [
    ({"hook_event_name": "Stop"}, "complete"), ({"hook_event_name": "Stop", "background_tasks": [{}]}, None),
    ({"hook_event_name": "Stop", "agent_id": "child"}, None), ({"hook_event_name": "SubagentStop"}, None),
    ({"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_use_id": "question-1"}, "question"),
    ({"hook_event_name": "PreToolUse", "tool_name": "Bash"}, None), ({"hook_event_name": "PermissionRequest"}, "approval"),
])
def test_hooks_never_make_permission_decisions(payload, kind, monkeypatch, tmp_path):
    from io import StringIO
    monkeypatch.setattr(agent.sys, "stdin", StringIO(json.dumps(payload | {"session_id": "test"})))
    monkeypatch.setattr(agent, "paths", lambda: (tmp_path, tmp_path / "codex", tmp_path / "claude"))
    result = agent.hook()
    assert "decision" not in result and "continue" not in result
    events = TerminalNotificationParser().feed(result.get("terminalSequence", ""))
    assert [event["kind"] for event in events] == ([kind] if kind else [])


def test_tmux_setup_preserves_an_existing_pipe():
    class Client:
        def __init__(self): self.commands = []
        async def run(self, command, **kwargs):
            self.commands.append(command)
            return SimpleNamespace(exit_status=0, stdout="1|someone-else|/dev/pts/2|off|")
    client = Client()
    session = SimpleNamespace(client=client, tmux_binary_path="/usr/bin/tmux", enhanced_fingerprint="safe")
    with pytest.raises(ValueError, match="already has an output pipe"): asyncio.run(configure_tmux_relay(session, "check"))
    assert len(client.commands) == 1 and "display-message" in client.commands[0]


def test_version_detection_uses_the_cli_in_the_target_path(tmp_path, monkeypatch):
    executable = tmp_path / "codex"
    executable.write_text('#!/bin/sh\nprintf "codex-cli 0.163.0\\n"\n'); executable.chmod(0o700)
    monkeypatch.setenv("PATH", str(tmp_path))
    assert agent.version("codex") == "codex-cli 0.163.0"
    assert agent.version("claude") is None
    assert agent.supports(agent.version("codex"), (0, 163, 0))
    assert not agent.supports("codex-cli 0.100.0", (0, 163, 0))
    monkeypatch.setattr(agent.Path, "home", lambda: tmp_path)
    local = tmp_path / ".local" / "bin"; local.mkdir(parents=True)
    (local / "claude").write_text('#!/bin/sh\nprintf "2.1.306 (Claude Code)\\n"\n'); (local / "claude").chmod(0o700)
    assert agent.version("claude") == "2.1.306 (Claude Code)"


def test_question_permission_and_delayed_notification_share_one_event(tmp_path, monkeypatch):
    from io import StringIO
    monkeypatch.setattr(agent, "paths", lambda: (tmp_path, tmp_path / "codex", tmp_path / "claude"))
    def call(payload):
        monkeypatch.setattr(agent.sys, "stdin", StringIO(json.dumps({"session_id": "same"} | payload)))
        return agent.hook()
    question = call({"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_use_id": "call-1"})
    assert call({"hook_event_name": "PermissionRequest", "tool_name": "AskUserQuestion"}) == {}
    late = call({"hook_event_name": "Notification", "notification_type": "permission_prompt"})
    assert question == late
    call({"hook_event_name": "UserPromptSubmit"})
    new = call({"hook_event_name": "Notification", "notification_type": "permission_prompt"})
    assert new != question


def test_custom_stop_hook_cannot_make_a_false_completion_fallback(tmp_path, monkeypatch):
    from io import StringIO
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "continue-working"}]}]}}))
    monkeypatch.setattr(agent, "paths", lambda: (tmp_path, tmp_path / "codex", settings))
    monkeypatch.setattr(agent.sys, "stdin", StringIO(json.dumps({"session_id": "test", "hook_event_name": "Stop"})))
    assert agent.hook() == {}


def test_invalid_config_aborts_before_any_cli_settings_are_written(tmp_path, monkeypatch):
    root = tmp_path / "agent"; codex = tmp_path / "codex.toml"; claude = tmp_path / "claude.json"
    codex.write_text("invalid = [")
    original = '{"theme":"light"}'; claude.write_text(original)
    monkeypatch.setattr(agent, "paths", lambda: (root, codex, claude))
    monkeypatch.setattr(agent, "version", lambda command: "0.163.0" if command == "codex" else "2.1.306")
    with pytest.raises(ValueError): agent.configure("install")
    assert claude.read_text() == original and codex.read_text() == "invalid = ["
    assert not (root / "notifications.json").exists()


def test_uninstall_removes_only_new_empty_configs_and_preserves_new_comments(tmp_path, monkeypatch):
    root = tmp_path / "agent"; codex = tmp_path / "codex.toml"; claude = tmp_path / "claude.json"
    monkeypatch.setattr(agent, "paths", lambda: (root, codex, claude))
    monkeypatch.setattr(agent, "version", lambda command: "0.163.0" if command == "codex" else "2.1.306")
    agent.configure("install"); agent.configure("uninstall")
    assert not codex.exists() and not claude.exists()
    agent.configure("install")
    codex.write_text(codex.read_text() + "# User note added later\n")
    agent.configure("uninstall")
    assert "# User note added later" in codex.read_text()
    assert not claude.exists()


def test_setup_status_checks_real_configuration_instead_of_only_the_manifest(tmp_path, monkeypatch):
    root = tmp_path / "agent"; codex = tmp_path / "codex.toml"; claude = tmp_path / "claude.json"
    monkeypatch.setattr(agent, "paths", lambda: (root, codex, claude))
    monkeypatch.setattr(agent, "version", lambda name: "0.163.0" if name == "codex" else "2.1.306")
    assert agent.configure("install")["configuration"] == {"codex": "configured", "claude": "configured"}
    changed_hooks = json.loads(claude.read_text())
    changed_hooks["hooks"]["PreToolUse"][0]["matcher"] = "Bash"
    claude.write_text(json.dumps(changed_hooks))
    assert agent.configure("status")["configuration"]["claude"] == "changed"
    codex.write_text(codex.read_text().replace('notification_condition = "always"', 'notification_condition = "unfocused"'))
    claude.unlink()
    result = agent.configure("status")
    assert result["installed"]
    assert result["configuration"] == {"codex": "changed", "claude": "missing"}


def test_setup_api_keeps_runtime_verification_distinct_and_passes_running_configuration(database, monkeypatch):
    from app.services.notification_runtime import public_status
    context = {"state": "attached", "app": "codex", "identity": "1:1", "binding": "thread", "config": {"CODEX_HOME": "/running/codex"}, "version_command": ["/proc/1/exe"], "capabilities": {"complete": "ready"}, "candidates": []}
    calls = []
    class Monitor:
        task = None
        async def restart(self): calls.append("restart")
        async def close(self): calls.append("close")
        def snapshot(self): return public_status(context)
    session = SimpleNamespace(user_id=1, status="active", enhanced_enabled=False, client=object(), notification_monitor=Monitor())
    async def probe(value): assert value is session; return context
    async def configure(client, action, running):
        calls.append((action, running))
        return {"installed": action != "uninstall", "notes": [], "configuration": {"codex": "configured"}}
    monkeypatch.setattr(api, "probe_runtime", probe)
    monkeypatch.setattr(api, "configure_notifications", configure)
    state = SimpleNamespace(session_manager=SimpleNamespace(get_session=lambda value: session))
    app = FastAPI(); app.include_router(api.router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=1)
    app.dependency_overrides[get_state] = lambda: state
    def db_override():
        with database.session() as db: yield db
    app.dependency_overrides[get_db] = db_override
    with TestClient(app) as client:
        result = client.post("/notifications/setup/one", json={"action": "install"})
        assert result.status_code == 200
        assert result.json()["runtime"]["capabilities"] == {"complete": "ready"}
        assert "config" not in result.json()["runtime"] and "version_command" not in result.json()["runtime"]
        assert calls == [("install", context), "restart"]
        assert client.post("/notifications/setup/two", json={"action": "install"}).status_code == 404
        assert client.post("/notifications/setup/one", json={"action": "bind", "binding": "foreign-thread"}).status_code == 409
        removed = client.post("/notifications/setup/one", json={"action": "uninstall"})
        assert removed.json()["runtime"]["state"] == "not_configured" and "close" in calls


def test_remote_installer_runs_its_actual_uploaded_script_and_restores_configs(tmp_path):
    import os
    from app.services.notification_setup import configure_notifications
    binaries = tmp_path / "fake bin"; binaries.mkdir()
    for name, value in (("codex", "codex-cli 0.163.0"), ("claude", "2.1.306 (Claude Code)")):
        path = binaries / name; path.write_text(f"#!/bin/sh\nprintf '{value}\\n'\n"); path.chmod(0o700)
    codex = tmp_path / "codex config"; claude = tmp_path / "claude config"
    codex.mkdir(); claude.mkdir()
    original_codex = 'model="keep"\n[tui]\nnotifications=false\n'
    (codex / "config.toml").write_text(original_codex)
    original_claude = {"theme": "light", "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "user-hook"}]}]}}
    (claude / "settings.json").write_text(json.dumps(original_claude))
    class ShellClient:
        async def run(self, command, **kwargs):
            environment = dict(os.environ, PATH=str(binaries) + ":" + os.environ["PATH"], CODEX_HOME=str(codex), CLAUDE_CONFIG_DIR=str(claude))
            process = await asyncio.create_subprocess_shell(command, env=environment, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, stderr = await asyncio.wait_for(process.communicate(), 40)
            return SimpleNamespace(exit_status=process.returncode, stdout=stdout.decode(), stderr=stderr.decode())
    async def scenario():
        result = await configure_notifications(ShellClient(), "install")
        assert result["installed"] and result["codex_version"] == "codex-cli 0.163.0"
        import tomllib
        assert tomllib.loads((codex / "config.toml").read_text())["tui"]["notification_method"] == "osc9"
        assert (await configure_notifications(ShellClient(), "status"))["installed"]
        assert not (await configure_notifications(ShellClient(), "uninstall"))["installed"]
    asyncio.run(scenario())
    import tomllib
    assert tomllib.loads((codex / "config.toml").read_text()) == tomllib.loads(original_codex)
    config = json.loads((claude / "settings.json").read_text())
    assert config["theme"] == "light" and config["hooks"]["PreToolUse"] == original_claude["hooks"]["PreToolUse"]
