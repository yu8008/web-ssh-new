from __future__ import annotations

import asyncio
import base64
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import PurePosixPath
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.api import clipboard_cache as api, system_settings as settings_api
from app.api.dependencies import get_current_user, get_db, get_state
from app.core.db import Database
from app.models.connection import Connection
from app.models.user import User  # noqa: F401
from app.services import clipboard_cache as cache
from app.services.bootstrap import ensure_system_settings
from app.services.crypto import CryptoService
from app.services.system_settings import ensure_system_settings_record, load_runtime_system_settings

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=")
NOW = datetime(2026, 10, 22, 12, tzinfo=timezone.utc)


class ShellClient:
    def __init__(self):
        self.closed = False

    async def run(self, command, *, check=False, timeout=30, encoding="utf-8"):
        process = await asyncio.create_subprocess_shell(command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout)
        return SimpleNamespace(exit_status=process.returncode, stdout=stdout if encoding is None else stdout.decode(), stderr=stderr)

    def close(self):
        self.closed = True

    async def wait_closed(self):
        pass


@pytest.fixture
def remote(tmp_path, monkeypatch):
    parent = tmp_path / "remote"
    parent.mkdir()
    monkeypatch.setattr(cache, "CACHE_PARENT", PurePosixPath(str(parent)))
    monkeypatch.setattr(cache, "utc_now", lambda: NOW)
    monkeypatch.setattr(api, "utc_now", lambda: NOW)
    return parent


def image(remote, token="old", age=0, extension="png"):
    directory = remote / f"webssh-clipboard.{token}"
    directory.mkdir(mode=0o700)
    path = directory / f"image.{extension}"
    path.write_bytes(PNG)
    path.chmod(0o600)
    modified = NOW.timestamp() - age
    os.utime(path, (modified, modified))
    return path


@pytest.mark.parametrize("days", [3, 7])
def test_automatic_cleanup_uses_exact_expiry_and_preserves_recent_images(remote, days):
    expired = image(remote, "expired", age=days * 86400)
    recent = image(remote, "recent", age=days * 86400 - 1)
    future = image(remote, "future", age=-10)
    result = asyncio.run(cache.cleanup_expired_images(ShellClient(), days))
    assert result == {"deleted": 1, "freed_bytes": len(PNG)}
    assert not expired.parent.exists()
    assert recent.read_bytes() == PNG and future.read_bytes() == PNG


def test_inventory_includes_legacy_uploads_but_skips_links_and_other_files(remote):
    legacy = image(remote, "Foa7riEBG6", age=86400)
    target = remote / "keep.png"
    target.write_bytes(PNG)
    directory = remote / "webssh-clipboard.link"
    directory.mkdir()
    (directory / "image.png").symlink_to(target)
    (remote / "webssh-clipboard.alias").symlink_to(legacy.parent, target_is_directory=True)
    image(remote, "invalid-token", age=86400)
    listing = asyncio.run(cache.list_cached_images(ShellClient()))
    assert [item["id"] for item in listing] == ["Foa7riEBG6.png"]
    assert listing[0]["size"] == len(PNG)
    assert listing[0]["created_at"] == datetime.fromtimestamp(NOW.timestamp() - 86400, timezone.utc)
    assert asyncio.run(cache.delete_cached_images(ShellClient(), ["link.png", "alias.png"])) == []
    assert target.read_bytes() == PNG and legacy.read_bytes() == PNG


def test_cleanup_never_recursively_deletes_unrelated_directory_contents(remote):
    old = image(remote, age=8 * 86400)
    keep = old.parent / "notes.txt"
    keep.write_text("keep me")
    result = asyncio.run(cache.cleanup_expired_images(ShellClient(), 3))
    assert result["deleted"] == 1
    assert keep.read_text() == "keep me"


@pytest.mark.parametrize("identifier", ["../keep.png", "a.png;id", "a/b.png", "a.svg", "$(id).png", "a.png\n"])
def test_delete_only_accepts_gateway_image_identifiers(remote, identifier):
    with pytest.raises(ValueError):
        asyncio.run(cache.delete_cached_images(ShellClient(), [identifier]))


def test_failed_inventory_does_not_start_deleting_files(remote):
    class BrokenClient:
        async def run(self, *_args, **_kwargs):
            return SimpleNamespace(exit_status=1, stdout="")
    old = image(remote, age=9 * 86400)
    with pytest.raises(RuntimeError):
        asyncio.run(cache.cleanup_expired_images(BrokenClient(), 3))
    assert old.exists()


@pytest.fixture
def gateway(remote, tmp_path):
    database = Database(f"sqlite:///{tmp_path / 'gateway.db'}")
    database.create_tables()
    key = b"12345678901234567890123456789012"
    encrypted = CryptoService([key]).encrypt(json.dumps({"password": "test-only"}))
    auth_data = json.dumps({"nonce": encrypted.nonce, "ciphertext": encrypted.ciphertext})
    with database.session() as db:
        ensure_system_settings_record(db)
        for user_id in [1, 2]:
            db.add(Connection(user_id=user_id, name="test", host=f"test-{user_id}", port=22, username="tester", auth_type="password", auth_data=auth_data))
    clients = []

    async def connect(connection, payload):
        assert payload == {"password": "test-only"}
        client = ShellClient()
        clients.append(client)
        return client

    state = SimpleNamespace(database=database, config=SimpleNamespace(secret_keys=[key]), session_manager=SimpleNamespace(connect_client=connect))
    app = FastAPI()
    app.include_router(api.router)
    app.include_router(settings_api.router)
    app.dependency_overrides[get_state] = lambda: state
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=1)

    def db_dependency():
        with database.session() as db:
            yield db

    app.dependency_overrides[get_db] = db_dependency
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, state=state, database=database, clients=clients, app=app)


def test_management_works_without_a_terminal_session_and_closes_temporary_clients(remote, gateway):
    old = image(remote, "old", age=4 * 86400)
    recent = image(remote, "new", age=86400)
    response = gateway.client.get("/system/clipboard-cache/1?limit=1")
    assert response.status_code == 200
    payload = response.json()
    assert payload["total_count"] == 2 and payload["total_bytes"] == len(PNG) * 2
    assert payload["expired_count"] == 1 and payload["images"][0]["id"] == "new.png"
    preview = gateway.client.get("/system/clipboard-cache/1/image/new.png")
    assert preview.content == PNG and preview.headers["cache-control"] == "no-store"
    assert gateway.client.post("/system/clipboard-cache/1/cleanup").json()["deleted"] == 1
    assert not old.exists() and recent.exists()
    removed = gateway.client.request("DELETE", "/system/clipboard-cache/1", json={"image_ids": ["new.png"]})
    assert removed.json() == {"deleted_ids": ["new.png"]}
    assert not recent.exists()
    assert all(client.closed for client in gateway.clients)


@pytest.mark.parametrize("method,suffix,payload", [("GET", "", None), ("POST", "/cleanup", None), ("DELETE", "", {"image_ids": ["x.png"]}), ("GET", "/image/x.png", None)])
def test_foreign_connections_are_inaccessible_before_opening_ssh(gateway, method, suffix, payload):
    response = gateway.client.request(method, f"/system/clipboard-cache/2{suffix}", json=payload)
    assert response.status_code == 404
    assert gateway.clients == []


def test_image_cache_requires_login(gateway):
    del gateway.app.dependency_overrides[get_current_user]
    assert gateway.client.get("/system/clipboard-cache/1").status_code == 401
    assert gateway.clients == []


def test_retention_setting_is_validated_persisted_and_old_clients_preserve_it(gateway):
    settings = gateway.client.get("/system/settings").json()
    assert settings["clipboard_image_retention_days"] == 3
    settings["clipboard_image_retention_days"] = 7
    assert gateway.client.put("/system/settings", json=settings).json()["clipboard_image_retention_days"] == 7
    del settings["clipboard_image_retention_days"]
    assert gateway.client.put("/system/settings", json=settings).json()["clipboard_image_retention_days"] == 7
    settings["clipboard_image_retention_days"] = 1
    assert gateway.client.put("/system/settings", json=settings).status_code == 422
    with gateway.database.session() as db:
        assert load_runtime_system_settings(db).clipboard_image_retention_days == 7


def test_existing_database_gets_default_cleanup_policy(tmp_path):
    database = Database(f"sqlite:///{tmp_path / 'legacy.db'}")
    database.create_tables()
    with database._engine.begin() as connection:
        connection.execute(text("ALTER TABLE system_settings DROP COLUMN clipboard_image_retention_days"))
    ensure_system_settings(database)
    with database.session() as db:
        assert load_runtime_system_settings(db).clipboard_image_retention_days == 3


def test_worker_continues_after_an_offline_target_and_deduplicates_accounts(remote, gateway, monkeypatch):
    old = image(remote, "old", age=4 * 86400)
    attempted = []

    @asynccontextmanager
    async def connect(_state, connection):
        attempted.append(connection.host)
        if connection.host == "test-1":
            raise OSError("offline")
        yield ShellClient()

    with gateway.database.session() as db:
        conn = db.get(Connection, 2)
        db.add(Connection(user_id=2, name="alias", host=conn.host, port=conn.port, username=conn.username, auth_type=conn.auth_type, auth_data=conn.auth_data))
    monkeypatch.setattr(cache, "cache_ssh_client", connect)
    asyncio.run(cache.cleanup_saved_connections(gateway.state))
    assert sorted(attempted) == ["test-1", "test-2"]
    assert not old.exists()
