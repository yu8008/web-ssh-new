from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from app.api import system
from app.core.db import Database, utc_now
from app.models.session import SessionRecord
from app.models.connection import Connection
from app.models.user import User  # noqa: F401


def test_project_endpoint_checks_ownership_and_liveness_before_using_cached_metadata(tmp_path, monkeypatch):
    database = Database(f"sqlite:///{tmp_path / 'project.db'}"); database.create_tables()
    with database.session() as db:
        connection = Connection(user_id=1, name="test", host="example.invalid", port=22, username="ops", auth_type="password", auth_data="{}")
        db.add(connection); db.flush()
        db.add(SessionRecord(id="owned", connection_id=connection.id, user_id=1, status="active", started_at=utc_now(), last_activity=utc_now(), pty_info="{}", session_order=1))
    live = SimpleNamespace(user_id=1, status="active")
    state = SimpleNamespace(session_manager=SimpleNamespace(get_session=lambda key: live))
    calls = []
    async def read_project(session, open_client, include_git):
        calls.append(include_git)
        return {"state": "ready", "cwd": "/private/project"}
    monkeypatch.setattr(system, "read_project", read_project)
    with database.session() as db:
        with pytest.raises(HTTPException) as error:
            asyncio.run(system.get_project_context("owned", True, state, SimpleNamespace(id=2), db))
        assert error.value.status_code == 404 and not calls
        result = asyncio.run(system.get_project_context("owned", True, state, SimpleNamespace(id=1), db))
        assert result["cwd"] == "/private/project" and calls == [True]
        live.status = "disconnected"
        with pytest.raises(HTTPException):
            asyncio.run(system.get_project_context("owned", True, state, SimpleNamespace(id=1), db))
        assert calls == [True]
