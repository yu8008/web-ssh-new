from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.dependencies import get_current_user, get_db, get_state
from app.core.db import utc_now
from app.models.connection import Connection
from app.services.clipboard_cache import (
    CACHE_ID_PATTERN, cache_path, cache_ssh_client, cleanup_expired_images,
    delete_cached_images, list_cached_images,
)
from app.services.clipboard_image import MAX_CLIPBOARD_IMAGE_BYTES, image_extension
from app.services.system_settings import load_runtime_system_settings

router = APIRouter(prefix="/system/clipboard-cache", tags=["system"])


class CachedImage(BaseModel):
    id: str
    path: str
    size: int
    created_at: datetime
    expires_at: datetime
    expired: bool


class CacheInventory(BaseModel):
    images: list[CachedImage]
    total_count: int
    total_bytes: int
    expired_count: int
    retention_days: int
    offset: int
    limit: int


class DeleteImagesRequest(BaseModel):
    image_ids: list[str] = Field(min_length=1, max_length=100)


def owned_connection(connection_id: int, user=Depends(get_current_user), db=Depends(get_db)):
    connection = db.execute(select(Connection).where(Connection.id == connection_id, Connection.user_id == user.id)).scalar_one_or_none()
    if connection is None:
        raise HTTPException(status_code=404, detail="连接不存在")
    return connection


@router.get("/{connection_id}", response_model=CacheInventory)
async def get_cache(
    connection_id: int,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    connection=Depends(owned_connection),
    state=Depends(get_state), db=Depends(get_db),
):
    retention_days = load_runtime_system_settings(db).clipboard_image_retention_days
    try:
        async with cache_ssh_client(state, connection) as client:
            images = await list_cached_images(client)
    except Exception as error:
        raise HTTPException(status_code=502, detail="Could not read clipboard image cache; check the SSH connection") from error
    now = utc_now()
    items = []
    for image in images:
        expires_at = image["created_at"] + timedelta(days=retention_days)
        items.append(CachedImage(**image, expires_at=expires_at, expired=expires_at <= now))
    return CacheInventory(
        images=items[offset:offset + limit], total_count=len(items), total_bytes=sum(image.size for image in items),
        expired_count=sum(image.expired for image in items), retention_days=retention_days, offset=offset, limit=limit,
    )


@router.post("/{connection_id}/cleanup")
async def clean_cache(connection_id: int, connection=Depends(owned_connection), state=Depends(get_state), db=Depends(get_db)):
    retention_days = load_runtime_system_settings(db).clipboard_image_retention_days
    try:
        async with cache_ssh_client(state, connection) as client:
            return await cleanup_expired_images(client, retention_days)
    except Exception as error:
        raise HTTPException(status_code=502, detail="Could not clean clipboard image cache") from error


@router.delete("/{connection_id}")
async def delete_images(connection_id: int, payload: DeleteImagesRequest, connection=Depends(owned_connection), state=Depends(get_state)):
    if any(not CACHE_ID_PATTERN.fullmatch(image_id) for image_id in payload.image_ids):
        raise HTTPException(status_code=400, detail="Invalid clipboard cache image id")
    try:
        async with cache_ssh_client(state, connection) as client:
            deleted = await delete_cached_images(client, list(dict.fromkeys(payload.image_ids)))
    except Exception as error:
        raise HTTPException(status_code=502, detail="Could not clean clipboard image cache") from error
    return {"deleted_ids": deleted}


@router.get("/{connection_id}/image/{image_id}")
async def read_image(connection_id: int, image_id: str, connection=Depends(owned_connection), state=Depends(get_state)):
    if not CACHE_ID_PATTERN.fullmatch(image_id):
        raise HTTPException(status_code=400, detail="Invalid clipboard cache image id")
    try:
        async with cache_ssh_client(state, connection) as client:
            images = await list_cached_images(client)
            if not any(image["id"] == image_id for image in images):
                raise HTTPException(status_code=404, detail="Clipboard cache image no longer exists")
            # The ID is an allowlisted token, never a caller-supplied shell path.
            path = cache_path(image_id)
            result = await client.run(
                f"[ ! -L '{path.parent}' ] && [ ! -L '{path}' ] && head -c {MAX_CLIPBOARD_IMAGE_BYTES + 1} '{path}'",
                encoding=None, check=False, timeout=30,
            )
            if result.exit_status != 0:
                raise HTTPException(status_code=404, detail="Clipboard cache image no longer exists")
            mime = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}[image_id.rsplit(".", 1)[1]]
            image_extension(result.stdout, mime)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=502, detail="Could not read clipboard image cache; check the SSH connection") from error
    return Response(content=result.stdout, media_type=mime, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
