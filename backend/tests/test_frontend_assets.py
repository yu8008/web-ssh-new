from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys


def test_self_hosted_fonts_have_correct_mime_types_without_system_mime_entries(tmp_path):
    # Exercise the real frontend mount with an isolated database and assets;
    # importing the application must never initialize the deployment database.
    source = Path(__file__).resolve().parents[2] / "frontend" / "public"
    static = tmp_path / "backend/frontend/dist"
    shutil.copytree(source, static)
    (static / "index.html").write_text("<!doctype html><title>Asset test</title>")
    code = """
import mimetypes,sys
from pathlib import Path
from fastapi.testclient import TestClient
import app.main as main
fake_source=Path(sys.argv[1])
main.Path=lambda value: fake_source
mimetypes.add_type('text/plain','.woff2')
client=TestClient(main.create_app())
for path in ('/fonts/space-grotesk.woff2','/fonts/ibm-plex-mono.woff2'):
    response=client.get(path)
    assert response.status_code==200
    assert response.headers['content-type']=='font/woff2'
    assert response.content.startswith(b'wOF2')
for path in ('/art/signal-orbit.svg','/favicon.svg'):
    response=client.get(path)
    assert response.status_code==200
    assert response.headers['content-type']=='image/svg+xml'
client.close()
"""
    result = subprocess.run([sys.executable, "-c", code, str(tmp_path / "backend/app/main.py")],
        capture_output=True, text=True, timeout=20, env={**os.environ,
            "SECRET_KEY": "12345678901234567890123456789012",
            "INITIAL_ADMIN_PASSWORD": "DesignAssetTest123",
            "DATABASE_URL": "sqlite:///" + str(tmp_path / "assets.db"),
        })
    assert result.returncode == 0, result.stderr
