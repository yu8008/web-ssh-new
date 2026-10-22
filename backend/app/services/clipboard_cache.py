"""Inventory and expire only Gateway clipboard images on saved SSH targets.

The remote files remain the source of truth, including images from older
Gateway versions. No image copies are kept on the Gateway's own disk.
"""
from __future__ import annotations

import asyncio
import json
import re
import shlex
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import PurePosixPath

from sqlalchemy import select

from app.core.db import utc_now
from app.core.logging import get_logger
from app.models.connection import Connection
from app.services.crypto import CryptoService, EncryptedPayload
from app.services.system_settings import load_runtime_system_settings

logger = get_logger(__name__)
CACHE_PARENT = PurePosixPath("/tmp")
CLEANUP_INTERVAL_SECONDS = 3600
CACHE_ID_PATTERN = re.compile(r"([A-Za-z0-9]{1,64})\.(png|jpg|webp|gif)")


def cache_path(image_id: str) -> PurePosixPath:
    match = CACHE_ID_PATTERN.fullmatch(image_id)
    if not match:
        raise ValueError("Invalid clipboard cache image id")
    token, extension = match.groups()
    return CACHE_PARENT / f"webssh-clipboard.{token}" / f"image.{extension}"


def _owned_directory_guard(directory: str) -> str:
    # Never follow symlinks or operate on another remote user's cache. Private
    # mktemp directories prevent a different UID from replacing their contents.
    return (
        f'[ -d {directory} ] && [ ! -L {directory} ] && '
        f'[ -n "$(find {directory} -prune -user "$(id -u)" -print 2>/dev/null)" ]'
    )


def _stat_command(path: str, linux: str, bsd: str) -> str:
    return f"LC_ALL=C stat -c '{linux}' {path} 2>/dev/null || LC_ALL=C stat -f '{bsd}' {path} 2>/dev/null"


async def list_cached_images(client) -> list[dict]:
    directory_guard = _owned_directory_guard('"$webssh_cache_dir"')
    file_stat = _stat_command('"$webssh_cache_file"', "%s|%Y|%u", "%z|%m|%u")
    command = (
        'printf "uid|%s\\n" "$(id -u)"\n'
        f"for webssh_cache_dir in {shlex.quote(str(CACHE_PARENT))}/webssh-clipboard.*; do\n"
        f'  {directory_guard} || continue\n'
        '  webssh_cache_token=${webssh_cache_dir##*/webssh-clipboard.}\n'
        '  case "$webssh_cache_token" in ""|*[!A-Za-z0-9]*) continue;; esac\n'
        '  for webssh_cache_ext in png jpg webp gif; do\n'
        '    webssh_cache_file="$webssh_cache_dir/image.$webssh_cache_ext"\n'
        '    [ -f "$webssh_cache_file" ] && [ ! -L "$webssh_cache_file" ] || continue\n'
        f'    webssh_cache_stat=$({file_stat}) || exit 1\n'
        '    printf "%s.%s|%s\\n" "$webssh_cache_token" "$webssh_cache_ext" "$webssh_cache_stat"\n'
        '  done\n'
        'done\n'
    )
    result = await client.run(command, check=False, timeout=30)
    if result.exit_status != 0:
        raise RuntimeError("Could not list clipboard image cache")
    lines = str(result.stdout or "").splitlines()
    if not lines or not re.fullmatch(r"uid\|\d+", lines[0]):
        raise RuntimeError("Invalid clipboard image cache inventory")
    uid = lines[0].split("|")[1]
    images = []
    for line in lines[1:]:
        parts = line.split("|")
        if len(parts) != 4 or not CACHE_ID_PATTERN.fullmatch(parts[0]) or parts[3] != uid:
            continue
        try:
            size, modified = int(parts[1]), int(parts[2])
            if size < 0 or modified < 0:
                continue
            created_at = datetime.fromtimestamp(modified, timezone.utc)
        except (ValueError, OverflowError, OSError):
            continue
        images.append({"id": parts[0], "path": str(cache_path(parts[0])), "size": size, "created_at": created_at})
    return sorted(images, key=lambda image: (image["created_at"], image["id"]), reverse=True)


async def delete_cached_images(client, image_ids: list[str]) -> list[str]:
    deleted = []
    # Bound command sizes when clearing a large, old cache.
    for offset in range(0, len(image_ids), 100):
        commands = []
        for image_id in image_ids[offset:offset + 100]:
            path = cache_path(image_id)
            directory, filename = shlex.quote(str(path.parent)), shlex.quote(str(path))
            owner = _stat_command(filename, "%u", "%u")
            commands.append(
                f"if {_owned_directory_guard(directory)} && [ -f {filename} ] && [ ! -L {filename} ] "
                f'&& [ "$({owner})" = "$(id -u)" ]; then\n'
                f"  if rm -f -- {filename}; then\n"
                f"    printf '%s\\n' {shlex.quote(image_id)}\n"
                f"    rmdir -- {directory} 2>/dev/null || :\n"
                "  else\n"
                "    webssh_cache_delete_failed=1\n"
                "  fi\n"
                "fi\n"
            )
        command = "webssh_cache_delete_failed=0\n" + "".join(commands) + 'exit "$webssh_cache_delete_failed"\n'
        result = await client.run(command, check=False, timeout=30)
        if result.exit_status != 0:
            raise RuntimeError("Could not clean clipboard image cache")
        requested = set(image_ids[offset:offset + 100])
        deleted.extend(image_id for image_id in str(result.stdout or "").splitlines() if image_id in requested)
    return deleted


async def cleanup_expired_images(client, retention_days: int) -> dict:
    if retention_days not in {3, 7}:
        raise ValueError("Clipboard image retention must be 3 or 7 days")
    now = utc_now().timestamp()
    images = await list_cached_images(client)
    expired = [image for image in images if image["created_at"].timestamp() + retention_days * 86400 <= now]
    deleted = set(await delete_cached_images(client, [image["id"] for image in expired]))
    return {"deleted": len(deleted), "freed_bytes": sum(image["size"] for image in expired if image["id"] in deleted)}


@asynccontextmanager
async def cache_ssh_client(state, connection):
    auth_data = json.loads(connection.auth_data)
    decrypted = CryptoService(state.config.secret_keys).decrypt(
        EncryptedPayload(nonce=auth_data["nonce"], ciphertext=auth_data["ciphertext"])
    )
    client = await asyncio.wait_for(state.session_manager.connect_client(connection, json.loads(decrypted)), timeout=20)
    try:
        yield client
    finally:
        client.close()
        with suppress(TimeoutError):
            await asyncio.wait_for(client.wait_closed(), timeout=5)


async def cleanup_saved_connections(state) -> None:
    with state.database.session() as db:
        retention_days = load_runtime_system_settings(db).clipboard_image_retention_days
        connections = db.execute(select(Connection)).scalars().all()
        db.expunge_all()
    # Connections sharing the same SSH account share the same remote cache.
    targets = {(conn.host, conn.port, conn.username): conn for conn in connections}
    semaphore = asyncio.Semaphore(3)

    async def clean(connection):
        async with semaphore:
            try:
                async with cache_ssh_client(state, connection) as client:
                    result = await cleanup_expired_images(client, retention_days)
                if result["deleted"]:
                    logger.info("clipboard-cache-cleaned connection_id=%s deleted=%s freed_bytes=%s", connection.id, result["deleted"], result["freed_bytes"])
            except Exception as error:
                # Offline targets are retried next pass; a failed target never
                # prevents cleaning other machines or touches terminal channels.
                logger.warning("clipboard-cache-cleanup-failed connection_id=%s error_type=%s", connection.id, type(error).__name__)

    await asyncio.gather(*(clean(connection) for connection in targets.values()))


async def run_clipboard_cleanup_worker(state) -> None:
    while True:
        try:
            await cleanup_saved_connections(state)
        except Exception as error:
            logger.warning("clipboard-cache-worker-failed error_type=%s", type(error).__name__)
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
