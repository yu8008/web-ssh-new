from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services import notification_runtime as runtime
from app.services.notification_monitor import NotificationMonitor, probe_runtime, runtime_command
from app.services import notification_agent as agent


@pytest.fixture(autouse=True)
def private_bindings_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime, "ROOT", tmp_path / "bindings")


def append(path, kind, turn="turn-1", **extra):
    with path.open("a") as stream:
        stream.write(json.dumps({"type": "event_msg", "payload": {"type": kind, "turn_id": turn, **extra}}) + "\n")


def rollout(home, session="session-1", source="cli", **extra):
    path = home / "sessions" / (session + ".jsonl")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"type": "session_meta", "payload": {"id": session, "source": source, "cwd": "/project", **extra}}) + "\n")
    return path


def process(proc, pid, parent=0, app="codex", arguments=(), home=None, foreground=True):
    folder = proc / str(pid); folder.mkdir(parents=True)
    fields = ["S", str(parent), "10", "10", "1", "10" if foreground else "20"] + ["0"] * 13 + [str(pid * 100)]
    (folder / "stat").write_text(str(pid) + " (" + app + ") " + " ".join(fields))
    (folder / "comm").write_text(app)
    (folder / "cmdline").write_bytes(b"\0".join(value.encode() for value in ("/bin/" + app, *arguments)) + b"\0")
    (folder / "environ").write_bytes(("CODEX_HOME=" + str(home) + "\0").encode() if home else b"")
    (folder / "cwd").symlink_to("/project")
    (folder / "exe").symlink_to("/bin/" + app)
    (folder / "fd").mkdir(); (folder / "fd/0").symlink_to("/dev/pts/1")
    return folder


def test_direct_process_binding_ignores_other_terminals_and_agent_rollouts(tmp_path):
    proc = tmp_path / "proc"; home = tmp_path / "codex"
    cli = process(proc, 10, home=home)
    other = process(proc, 11, home=home)
    daemon = process(proc, 12, arguments=("app-server",), home=home)
    own = rollout(home)
    foreign = rollout(home, "session-2")
    child = rollout(home, "agent-session", source={"subagent": {}})
    (cli / "fd/1").symlink_to(own); (other / "fd/1").symlink_to(foreign); (daemon / "fd/1").symlink_to(child)
    status = runtime.discover({"pid": 10, "key": "pane"}, proc)
    assert status["state"] == "attached" and status["binding"] == "session-1"
    assert {item["id"] for item in status["candidates"]} == {"session-1", "session-2"}
    assert status["config"] == {"CODEX_HOME": str(home)}
    public = runtime.public_status(status)
    assert "config" not in public and "executable" not in public
    assert all("path" not in item for item in public["candidates"])


def test_shared_daemon_never_guesses_latest_log_and_bindings_expire_when_candidates_change(tmp_path, monkeypatch, capsys):
    proc = tmp_path / "proc"; home = tmp_path / "codex"; root = tmp_path / "agent"; root.mkdir()
    monkeypatch.setattr(runtime, "ROOT", root)
    process(proc, 10, home=home)
    daemon = process(proc, 12, arguments=("app-server",), home=home)
    one = rollout(home); two = rollout(home, "session-2", source="vscode", originator="codex-tui", thread_source="user")
    (daemon / "fd/1").symlink_to(one); (daemon / "fd/2").symlink_to(two)
    discover = runtime.discover
    monkeypatch.setattr(runtime, "discover", lambda options: discover(options, proc))
    options = {"pid": 10, "key": "pane"}
    before = runtime.discover(options)
    assert before["state"] == "binding_required" and len(before["candidates"]) == 2
    runtime.main({**options, "action": "bind", "binding": "session-1", "signature": before["signature"]})
    assert json.loads(capsys.readouterr().out) == {"bound": True}
    assert runtime.discover(options)["binding"] == "session-1"
    three = rollout(home, "session-3"); (daemon / "fd/3").symlink_to(three)
    assert runtime.discover(options)["state"] == "binding_required"
    with pytest.raises(ValueError, match="changed"):
        runtime.main({**options, "action": "bind", "binding": "session-1", "signature": before["signature"]})


def test_rollout_validation_excludes_path_escapes_and_other_clients(tmp_path):
    home = tmp_path / "home"
    valid = rollout(home)
    assert runtime.rollout_metadata(valid, home)["id"] == "session-1"
    outside = rollout(tmp_path / "outside", "foreign")
    (home / "sessions/escape.jsonl").symlink_to(outside)
    assert runtime.rollout_metadata(home / "sessions/escape.jsonl", home) is None
    ide = rollout(home, "ide", source="vscode", originator="codex-vscode", thread_source="user")
    assert runtime.rollout_metadata(ide, home) is None


def test_binding_choices_use_bounded_titles_without_reading_message_contents(tmp_path):
    import sqlite3
    database = tmp_path / "state_5.sqlite"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE threads (id TEXT, title TEXT)")
        connection.execute("INSERT INTO threads VALUES (?, ?)", ("session", "Current task " * 100))
        connection.execute("INSERT INTO threads VALUES (?, ?)", ("unrelated", "Unrelated private title"))
    candidates = {"session": {"id": "session"}}
    runtime.candidate_titles(candidates, tmp_path)
    assert len(candidates["session"]["title"]) == 200
    assert "Unrelated" not in json.dumps(candidates)


def test_foreground_cli_and_resume_identity_are_used_instead_of_installed_binary(tmp_path):
    proc = tmp_path / "proc"; home = tmp_path / "codex"
    process(proc, 10, arguments=("resume", "session-1"), home=home)
    daemon = process(proc, 12, arguments=("app-server",), home=home)
    one = rollout(home); (daemon / "fd/1").symlink_to(one)
    assert runtime.discover({"pid": 10, "key": "pane"}, proc)["binding"] == "session-1"
    process(proc, 13, parent=10, app="claude", foreground=False)
    assert runtime.discover({"pid": 10, "key": "pane"}, proc)["app"] == "codex"


def test_regular_ssh_anchor_selects_only_its_own_terminal(tmp_path, monkeypatch):
    proc = tmp_path / "proc"; home = tmp_path / "codex"
    sshd = process(proc, 10, app="sshd-session")
    (sshd / "fd/0").unlink(); (sshd / "fd/0").symlink_to("/dev/null")
    process(proc, 11, parent=10, app="bash")
    cli = process(proc, 12, parent=11, home=home)
    observer = process(proc, 13, parent=10, app="python3")
    (observer / "fd/0").unlink(); (observer / "fd/0").symlink_to("pipe:[observer]")
    process(proc, 20, app="sshd-session")
    process(proc, 21, parent=20, home=home)
    own = rollout(home); (cli / "fd/1").symlink_to(own)
    monkeypatch.setattr(runtime.os, "getpid", lambda: 13)
    result = runtime.discover({"key": "regular-terminal"}, proc)
    assert result["pid"] == 12 and result["binding"] == "session-1"


def test_attach_to_in_progress_turn_reads_only_new_explicit_completions(tmp_path):
    path = rollout(tmp_path)
    append(path, "task_complete", "old-turn")
    append(path, "task_started", "running-turn")
    reader = runtime.RolloutTail(path, "session-1")
    assert reader.poll() == []
    for kind in ("task_started", "turn_aborted", "item_completed", "agent_message"):
        append(path, kind, "running-turn", text="Task complete? Permission required?")
    assert reader.poll() == []
    raw = json.dumps({"type": "event_msg", "payload": {"type": "task_complete", "turn_id": "running-turn", "last_agent_message": "PRIVATE BODY"}})
    with path.open("a") as stream: stream.write(raw[:35])
    assert reader.poll() == []
    with path.open("a") as stream: stream.write(raw[35:] + "\n")
    events = reader.poll()
    assert len(events) == 1 and events[0]["kind"] == "complete"
    assert "PRIVATE" not in json.dumps(events)
    append(path, "task_complete", "running-turn")
    assert reader.poll() == events  # The stable turn ID lets the service deduplicate.
    assert runtime.RolloutTail(path, "session-1").poll() == []
    path.write_text("")
    with pytest.raises(ValueError, match="replaced"): reader.poll()


def test_oversized_record_does_not_grow_memory_or_hide_next_completion(tmp_path):
    path = rollout(tmp_path); reader = runtime.RolloutTail(path, "session")
    with path.open("a") as stream: stream.write("x" * (2 * 1024 * 1024) + "\n")
    append(path, "task_complete")
    events = []
    for _ in range(10):
        events.extend(reader.poll())
        assert len(reader.pending) <= 1024 * 1024
    assert len(events) == 1


def test_monitor_prefers_bound_completion_and_cancels_without_touching_terminal():
    async def scenario():
        reader = asyncio.StreamReader()
        closed = []
        process = SimpleNamespace(stdout=reader, stdin=SimpleNamespace(write_eof=lambda: closed.append("eof")), close=lambda: closed.append("close"))
        class Client:
            async def create_process(self, command, **kwargs): return process
        session = SimpleNamespace(client=Client(), enhanced_enabled=False, enhanced_fingerprint=None, session_id="session", user_id=1)
        events = []; states = []
        monitor = NotificationMonitor(session, lambda *value: events.append(value), lambda *value: states.append(value))
        monitor.start()
        reader.feed_data((json.dumps({"type": "status", "runtime": {"state": "attached", "app": "codex", "identity": "1:1", "binding": "thread", "capabilities": {"complete": "ready"}, "candidates": []}}) + "\n").encode())
        await asyncio.wait_for(monitor.ready.wait(), 1)
        monitor.native({"app": "codex", "kind": "complete"})
        assert not events
        reader.feed_data((json.dumps({"type": "event", "event": {"app": "codex", "kind": "complete", "id": "stable"}}) + "\n").encode())
        await asyncio.sleep(0)
        assert events == [(1, "session", {"app": "codex", "kind": "complete", "id": "stable"})]
        monitor.native({"app": "codex", "kind": "attention"})
        assert len(events) == 2 and monitor.snapshot()["capabilities"]["attention"] == "verified"
        await monitor.close()
        assert closed == ["eof", "close"] and monitor.snapshot()["state"] == "disconnected"
        assert states[-1][0] == 1
    asyncio.run(scenario())


def test_concurrent_reconfiguration_does_not_leave_two_observers_running():
    async def scenario():
        processes = []
        class Client:
            async def create_process(self, command, **kwargs):
                assert not processes or processes[-1].closed
                reader = asyncio.StreamReader()
                reader.feed_data(b'{"type":"status","runtime":{"state":"observing","app":"claude","capabilities":{},"candidates":[]}}\n')
                process = SimpleNamespace(stdout=reader, closed=False, stdin=SimpleNamespace(write_eof=lambda: None))
                process.close = lambda: setattr(process, "closed", True)
                processes.append(process)
                return process
        session = SimpleNamespace(client=Client(), enhanced_enabled=False, enhanced_fingerprint=None, session_id="session", user_id=1)
        monitor = NotificationMonitor(session, lambda *args: None)
        await asyncio.gather(monitor.restart(), monitor.restart())
        assert len(processes) == 2 and processes[0].closed and not processes[1].closed
        await monitor.close()
        assert all(process.closed for process in processes)
    asyncio.run(scenario())


def test_unsupported_runtime_is_reported_as_unavailable_instead_of_verified_or_disconnected():
    async def scenario():
        reader = asyncio.StreamReader()
        reader.feed_data(b'{"type":"status","runtime":{"state":"unavailable","capabilities":{},"candidates":[]}}\n'); reader.feed_eof()
        class Client:
            async def run(self, command, **kwargs): return SimpleNamespace(exit_status=0, stdout='{"type":"status","runtime":{"state":"unavailable"}}')
            async def create_process(self, command, **kwargs): return SimpleNamespace(stdout=reader, stdin=SimpleNamespace(write_eof=lambda: None), close=lambda: None)
        session = SimpleNamespace(client=Client(), enhanced_enabled=False, enhanced_fingerprint=None, session_id="session", user_id=1)
        assert (await probe_runtime(session))["state"] == "unavailable"
        monitor = NotificationMonitor(session, lambda *args: None)
        monitor.start(); await monitor.task
        assert monitor.snapshot()["state"] == "unavailable" and not monitor.snapshot()["capabilities"]
    asyncio.run(scenario())


def test_empty_or_invalid_manifest_does_not_enable_an_observer(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime, "ROOT", tmp_path)
    path = tmp_path / "notifications.json"
    for value in ("{}", "[]", "broken", '{"codex":{}}'):
        path.write_text(value)
        assert not runtime.installed()
    path.write_text('{"codex":{"path":"/config.toml"}}')
    assert runtime.installed()


def test_multiple_configuration_homes_restore_their_original_settings(tmp_path, monkeypatch):
    root = tmp_path / "agent"; one = tmp_path / "one"; two = tmp_path / "two"
    one.mkdir(); two.mkdir()
    for directory in (one, two):
        (directory / "codex.toml").write_text('model="original"\n')
        (directory / "claude.json").write_text('{"theme":"original"}\n')
    monkeypatch.setattr(agent, "version", lambda name: "0.163.0" if name == "codex" else "2.1.306")
    for directory in (one, two, one):
        monkeypatch.setattr(agent, "paths", lambda directory=directory: (root, directory / "codex.toml", directory / "claude.json"))
        agent.configure("install")
    agent.configure("uninstall")
    for directory in (one, two):
        assert (directory / "codex.toml").read_text().strip() == 'model="original"'
        assert json.loads((directory / "claude.json").read_text()) == {"theme": "original"}


def test_installed_hook_retains_its_manifest_when_the_cli_overrides_home(tmp_path, monkeypatch):
    import os
    import subprocess
    import sys
    root = tmp_path / "installer-home/agent"; settings = tmp_path / "cli-home/settings.json"
    settings.parent.mkdir(parents=True)
    monkeypatch.setattr(agent, "paths", lambda: (root, tmp_path / "codex.toml", settings))
    monkeypatch.setattr(agent, "version", lambda name: "2.1.306" if name == "claude" else None)
    agent.configure("install")
    process = subprocess.run([sys.executable, str(root / "notifications.py"), "hook"], input=json.dumps({"session_id": "session", "hook_event_name": "Stop"}), text=True, capture_output=True, env={**os.environ, "HOME": str(settings.parent), "CLAUDE_CONFIG_DIR": str(settings.parent)}, timeout=5)
    assert process.returncode == 0 and "terminalSequence" in json.loads(process.stdout)


def test_runtime_command_keeps_shell_metacharacters_literal():
    import shlex
    session = SimpleNamespace(enhanced_enabled=True, enhanced_fingerprint="pane ' $(do-not-run)", tmux_binary_path="/tmp/bin with spaces/tmux", session_id="session")
    argv = shlex.split(runtime_command(session, "bind", binding="thread"))
    options = json.loads(argv[-1])
    assert options["target"] == "pane ' $(do-not-run):0.0" and options["binding"] == "thread"
