"""Store browser clipboard images on the SSH target without a display server."""
from __future__ import annotations

import re

from fastapi import HTTPException


MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024


def image_extension(content: bytes, content_type: str | None) -> str:
    if not content:
        raise HTTPException(status_code=400, detail="Clipboard image is empty")
    if len(content) > MAX_CLIPBOARD_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Clipboard image exceeds 20 MiB")
    signatures = {
        "image/png": ("png", content.startswith(b"\x89PNG\r\n\x1a\n")),
        "image/jpeg": ("jpg", content.startswith(b"\xff\xd8\xff")),
        "image/webp": ("webp", content[:4] == b"RIFF" and content[8:12] == b"WEBP"),
        "image/gif": ("gif", content[:6] in (b"GIF87a", b"GIF89a")),
    }
    extension, valid = signatures.get(content_type or "", ("", False))
    if not valid:
        raise HTTPException(status_code=400, detail="Unsupported clipboard image; use PNG, JPEG, WebP or GIF")
    return extension


async def store_clipboard_image(client, content: bytes, extension: str) -> str:
    if extension not in {"png", "jpg", "webp", "gif"}:
        raise ValueError("Invalid clipboard image extension")
    # Stream bytes over a separate SSH exec channel. This also works on targets
    # with SFTP disabled. No filename, path or shell code comes from the browser.
    command = (
        "umask 077\n"
        "webssh_clip_dir=$(mktemp -d /tmp/webssh-clipboard.XXXXXXXXXX) || exit 1\n"
        f'webssh_clip_path="$webssh_clip_dir/image.{extension}"\n'
        'if cat > "$webssh_clip_path"; then\n'
        '  printf \'%s\\n\' "$webssh_clip_path"\n'
        "else\n"
        '  rm -f "$webssh_clip_path"\n'
        '  rmdir "$webssh_clip_dir"\n'
        "  exit 1\n"
        "fi"
    )
    result = await client.run(command, input=content, encoding=None, check=False, timeout=30)
    stdout = result.stdout.decode("utf-8", errors="replace") if isinstance(result.stdout, bytes) else str(result.stdout or "")
    path = stdout.strip()
    if result.exit_status != 0 or not re.fullmatch(rf"/tmp/webssh-clipboard\.[A-Za-z0-9]+/image\.{extension}", path):
        raise RuntimeError("Could not save clipboard image on the SSH target")
    return path
