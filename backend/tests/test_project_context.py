from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import shlex
from types import SimpleNamespace

import pytest
from app.services import project_context as service


def session(enhanced=True):
    return SimpleNamespace(project_lock=asyncio.Lock(), project_cache={}, enhanced_enabled=enhanced,
                           enhanced_fingerprint="owned-session", tmux_binary_path="/my tmux", client="terminal-transport")


def test_enhanced_probe_uses_separate_client_and_coalesces_requests(monkeypatch):
    calls = []
    @asynccontextmanager
    async def open_client():
        calls.append("open"); yield "separate-client"; calls.append("close")
    async def execute(client, **options):
        calls.append((client, options)); await asyncio.sleep(.01)
        return {"state": "ready", "cwd": "/project", "git": {"state": "ready"}}
    monkeypatch.setattr(service, "execute", execute)
    async def scenario():
        current = session()
        results = await asyncio.gather(*(service.read_project(current, open_client, True) for _ in range(3)))
        assert results[0] == results[1] == results[2]
        assert calls == ["open", ("separate-client", {"tmux": "/my tmux", "target": "owned-session:0.0", "include_git": True}), "close"]
    asyncio.run(scenario())


def test_regular_terminal_identifies_its_own_transport_then_reads_git_separately(monkeypatch):
    calls = []
    @asynccontextmanager
    async def open_client():
        yield "separate-client"
    async def execute(client, **options):
        calls.append((client, options))
        return {"state": "ready", "cwd": "/specific", "git": {"state": "ready", "branch": "topic"}}
    monkeypatch.setattr(service, "execute", execute)
    async def scenario():
        result = await service.read_project(session(False), open_client, True)
        assert result["git"]["branch"] == "topic"
        assert calls == [("terminal-transport", {}), ("separate-client", {"action": "git", "cwd": "/specific", "include_git": True})]
    asyncio.run(scenario())


def test_failure_clears_old_project_after_cache_expires(monkeypatch):
    @asynccontextmanager
    async def open_client():
        yield "separate-client"
    async def execute(*args, **kwargs):
        raise TimeoutError()
    monkeypatch.setattr(service, "execute", execute)
    async def scenario():
        current = session(); current.project_cache[True] = (0, {"state": "ready", "cwd": "/old"})
        result = await service.read_project(current, open_client, True)
        assert result["state"] == "unavailable" and result["cwd"] is None and "git" not in result
    asyncio.run(scenario())


def test_command_quotes_all_options_without_shell_interpolation():
    value = "/project'; $(touch /tmp/never-project-command)"
    parts = shlex.split(service.runtime_command(action="git", cwd=value, include_git=True))
    assert parts[:2] == ["python3", "-c"]
    assert len(parts) == 4 and json.loads(parts[-1])["cwd"] == value


def test_invalid_probe_output_is_rejected():
    class Client:
        async def run(self, *args, **kwargs):
            return SimpleNamespace(exit_status=0, stdout='{"state":"ready","cwd":"relative"}')
    with pytest.raises(ValueError):
        asyncio.run(service.execute(Client()))
