from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.api.dependencies import get_current_user, get_current_user_from_ws, get_db, get_state
from app.core.db import utc_now
from app.models.notification import TerminalNotification, notification_payload
from app.models.session import SessionRecord
from app.services.notification_setup import configure_notifications, configure_tmux_relay
from app.services.notification_monitor import NotificationMonitor, probe_runtime, runtime_command
from app.services.notification_runtime import public_status

router = APIRouter(prefix="/notifications", tags=["notifications"])
logger = logging.getLogger(__name__)


def inbox(db, user_id: int):
    records = db.execute(select(TerminalNotification).where(TerminalNotification.user_id == user_id,
        TerminalNotification.created_at >= utc_now() - timedelta(days=7))
        .order_by(TerminalNotification.created_at.desc(), TerminalNotification.id.desc()).limit(200)).scalars()
    return [notification_payload(record) for record in records]


@router.get("")
async def list_notifications(user=Depends(get_current_user), db=Depends(get_db)):
    return inbox(db, user.id)


@router.patch("/{notification_id}/read")
async def read_notification(notification_id: str, user=Depends(get_current_user), db=Depends(get_db), state=Depends(get_state)):
    record = db.execute(select(TerminalNotification).where(TerminalNotification.id == notification_id, TerminalNotification.user_id == user.id)).scalar_one_or_none()
    if record is None:
        raise HTTPException(404, "Notification not found")
    if not record.read_at:
        record.read_at = utc_now()
        db.commit()
    if state.notifications:
        state.notifications.broadcast(user.id, {"type": "read", "id": record.id, "read_at": record.read_at.isoformat()})
    return notification_payload(record)


@router.post("/setup/{session_id}")
async def setup_notifications(session_id: str, payload: dict, user=Depends(get_current_user), db=Depends(get_db), state=Depends(get_state)):
    record = db.execute(select(SessionRecord).where(SessionRecord.id == session_id, SessionRecord.user_id == user.id)).scalar_one_or_none()
    if record is None:
        raise HTTPException(404, "Session not found")
    session = state.session_manager.get_session(session_id)
    if not session or session.user_id != user.id or session.status != "active":
        raise HTTPException(409, "Connect this terminal before configuring CLI notifications")
    action = payload.get("action", "status")
    if action not in {"status", "install", "uninstall", "bind"}:
        raise HTTPException(400, "Invalid notification setup action")
    try:
        runtime = await probe_runtime(session)
        if action == "bind":
            binding = payload.get("binding")
            if not isinstance(binding, str) or binding not in {item["id"] for item in runtime.get("candidates", [])}:
                raise ValueError("Choose a session from the current running CLI's candidates")
            bound = await session.client.run(runtime_command(session, "bind", binding=binding, signature=runtime.get("signature")), check=False, timeout=15)
            if bound.exit_status or str(bound.stdout).strip() != '{"bound":true}':
                raise ValueError("The running CLI changed; check the session again before binding")
        relay = None
        if session.enhanced_enabled:
            relay = await configure_tmux_relay(session, "check" if action == "install" else "status")
        result = await configure_notifications(session.client, "status" if action == "bind" else action, runtime)
        if session.enhanced_enabled and action in {"install", "uninstall"}:
            try:
                relay = await configure_tmux_relay(session, action, result["agent_path"])
            except Exception:
                if action == "install" and not result.get("was_installed"):
                    with suppress(Exception):
                        await configure_notifications(session.client, "uninstall")
                raise
        if relay:
            result["relay_active"] = relay["active"]
        monitor = session.notification_monitor
        if monitor is None and state.session_manager.on_notification:
            monitor = NotificationMonitor(session, state.session_manager.on_notification, state.session_manager.on_notification_status)
            session.notification_monitor = monitor
        if monitor:
            if action == "uninstall":
                await monitor.close()
            elif result["installed"] and (action in {"install", "bind"} or monitor.task is None or monitor.task.done()):
                await monitor.restart()
            result["runtime"] = monitor.snapshot() if result["installed"] else public_status(runtime)
        else:
            result["runtime"] = public_status(runtime)
        if not result["installed"] and result["runtime"].get("app"):
            result["runtime"].update({"state": "not_configured", "capabilities": {}})
        return result
    except (ValueError, RuntimeError) as error:
        raise HTTPException(409, str(error)) from error
    except Exception as error:
        raise HTTPException(502, "Could not configure CLI notifications on the SSH target") from error


@router.websocket("/ws")
async def notification_socket(websocket: WebSocket, state=Depends(get_state)):
    protocol = "webssh.notifications.v1"
    if protocol not in [part.strip() for part in websocket.headers.get("sec-websocket-protocol", "").split(",")]:
        await websocket.close(code=1008); return
    await websocket.accept(subprotocol=protocol)
    service = state.notifications
    user_id = None
    receiver = None
    pending = None
    try:
        with state.database.session() as db:
            user = get_current_user_from_ws(websocket, state, db)
            user_id = user.id
            if service is None:
                raise RuntimeError("Notifications unavailable")
            # Subscribe before snapshot, without an await: events cannot fall
            # through a gap. A snapshot is always silent on the browser.
            queue = service.subscribe(user_id, websocket)
            snapshot = inbox(db, user_id)
        await asyncio.wait_for(websocket.send_json({"type": "snapshot", "events": snapshot}), 5)
        receiver = asyncio.create_task(websocket.receive_text())
        while True:
            pending = asyncio.create_task(queue.get())
            done, _ = await asyncio.wait({receiver, pending}, return_when=asyncio.FIRST_COMPLETED)
            if receiver in done:
                message = receiver.result()
                receiver = asyncio.create_task(websocket.receive_text())
                if message == "ping":
                    await asyncio.wait_for(websocket.send_json({"type": "pong"}), 5)
            if pending in done:
                message = pending.result()
                if message["type"] == "resync":
                    with state.database.session() as db:
                        message = {"type": "snapshot", "events": inbox(db, user_id)}
                await asyncio.wait_for(websocket.send_json(message), 5)
            else:
                pending.cancel()
                with suppress(asyncio.CancelledError):
                    await pending
            pending = None
    except WebSocketDisconnect:
        pass
    except HTTPException:
        with suppress(Exception):
            await websocket.close(code=1008)
    except Exception:
        logger.warning("Notification socket interrupted", exc_info=True)
        with suppress(Exception):
            await websocket.close(code=1011)
    finally:
        for task in (receiver, pending):
            if task:
                task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await task
        if service and user_id is not None:
            service.unsubscribe(user_id, websocket)
