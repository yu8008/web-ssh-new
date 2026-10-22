from __future__ import annotations

import asyncio
import base64
import stat
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api import system
from app.api.dependencies import get_current_user, get_db, get_state
from app.services import clipboard_image


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=")


@pytest.mark.parametrize(("content", "mime", "extension"), [
    (PNG, "image/png", "png"),
    (b"\xff\xd8\xff\xe0jpeg", "image/jpeg", "jpg"),
    (b"RIFF\x04\0\0\0WEBP", "image/webp", "webp"),
    (b"GIF89a", "image/gif", "gif"),
])
def test_clipboard_image_format_matches_file_signature(content, mime, extension) -> None:
    assert clipboard_image.image_extension(content, mime) == extension


@pytest.mark.parametrize(("content", "mime"), [(b"", "image/png"), (b"text", "image/png"), (PNG, "image/svg+xml"), (PNG, "image/jpeg")])
def test_invalid_clipboard_images_are_rejected(content, mime) -> None:
    with pytest.raises(HTTPException) as error:
        clipboard_image.image_extension(content, mime)
    assert error.value.status_code == 400


def test_image_bytes_are_streamed_into_a_private_remote_file_without_sftp() -> None:
    class ShellClient:
        async def run(self, command, *, input, encoding, check, timeout):
            assert encoding is None and check is False and timeout == 30
            process = await asyncio.create_subprocess_shell(command, stdin=asyncio.subprocess.PIPE,
                                                          stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, _ = await asyncio.wait_for(process.communicate(input), 3)
            return SimpleNamespace(exit_status=process.returncode, stdout=stdout)

    async def scenario() -> None:
        path = Path(await clipboard_image.store_clipboard_image(ShellClient(), PNG, "png"))
        try:
            assert path.read_bytes() == PNG
            assert stat.S_IMODE(path.stat().st_mode) == 0o600
            assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
        finally:
            path.unlink()
            path.parent.rmdir()

    asyncio.run(scenario())


@pytest.mark.parametrize(("exit_status", "stdout"), [(1, b""), (0, b"/tmp/file.png\n"), (0, b"/tmp/webssh-clipboard.ok/image.png\nextra\n")])
def test_failed_or_invalid_remote_results_are_not_returned_to_the_terminal(exit_status, stdout) -> None:
    class FailingClient:
        async def run(self, *_args, **_kwargs):
            return SimpleNamespace(exit_status=exit_status, stdout=stdout)

    with pytest.raises(RuntimeError):
        asyncio.run(clipboard_image.store_clipboard_image(FailingClient(), PNG, "png"))


def app_client(*, authenticated=True, db=None) -> TestClient:
    app = FastAPI()
    app.include_router(system.router)
    app.dependency_overrides[get_state] = lambda: SimpleNamespace()
    app.dependency_overrides[get_db] = lambda: db
    if authenticated:
        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=1)
    return TestClient(app)


def test_clipboard_endpoint_uses_browser_bytes_and_ignores_untrusted_filename(monkeypatch) -> None:
    calls = []

    class SSHClient:
        async def run(self, command, **kwargs):
            calls.append((command, kwargs))
            return SimpleNamespace(exit_status=0, stdout=b"/tmp/webssh-clipboard.abc123/image.png\n")

    @asynccontextmanager
    async def resolve(session_id, _state, user, _db):
        assert session_id == "terminal" and user.id == 1
        yield SSHClient()

    monkeypatch.setattr(system, "resolve_ssh_client", resolve)
    with app_client() as client:
        response = client.post("/system/clipboard-image/terminal", files={"file": ("../../evil;touch injected.png", PNG, "image/png")})
    assert response.status_code == 200
    assert response.json() == {"path": "/tmp/webssh-clipboard.abc123/image.png"}
    assert calls[0][1]["input"] == PNG
    assert "injected" not in calls[0][0]


def test_oversized_image_is_rejected_before_connecting_to_ssh(monkeypatch) -> None:
    monkeypatch.setattr(system, "MAX_CLIPBOARD_IMAGE_BYTES", 8)
    monkeypatch.setattr(clipboard_image, "MAX_CLIPBOARD_IMAGE_BYTES", 8)
    with app_client() as client:
        response = client.post("/system/clipboard-image/terminal", files={"file": ("large.png", PNG, "image/png")})
    assert response.status_code == 413


def test_clipboard_upload_requires_login() -> None:
    with app_client(authenticated=False) as client:
        response = client.post("/system/clipboard-image/terminal", files={"file": ("image.png", PNG, "image/png")})
    assert response.status_code == 401


def test_clipboard_upload_checks_session_owner_before_remote_write() -> None:
    class ForeignSessionDB:
        def execute(self, query):
            assert query.compile().params == {"id_1": "foreign", "user_id_1": 1}
            return SimpleNamespace(scalar_one_or_none=lambda: None)

    with app_client(db=ForeignSessionDB()) as client:
        response = client.post("/system/clipboard-image/foreign", files={"file": ("image.png", PNG, "image/png")})
    assert response.status_code == 404


def test_remote_upload_failure_returns_a_clear_gateway_error(monkeypatch) -> None:
    class SSHClient:
        async def run(self, *_args, **_kwargs):
            raise OSError("remote disk full")

    @asynccontextmanager
    async def resolve(*_args):
        yield SSHClient()

    monkeypatch.setattr(system, "resolve_ssh_client", resolve)
    with app_client() as client:
        response = client.post("/system/clipboard-image/terminal", files={"file": ("image.png", PNG, "image/png")})
    assert response.status_code == 502
