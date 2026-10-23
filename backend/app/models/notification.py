from __future__ import annotations

from datetime import datetime
from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column
from app.core.db import Base, UTCDateTime, utc_now


class TerminalNotification(Base):
    __tablename__ = "terminal_notifications"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    session_name: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(32))
    app: Mapped[str] = mapped_column(String(32))
    source_key: Mapped[str | None] = mapped_column(String(256), nullable=True, unique=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utc_now, index=True)
    read_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


def notification_payload(record: TerminalNotification) -> dict:
    return {key: getattr(record, key) for key in ("id", "session_id", "session_name", "kind", "app")} | {
        "created_at": record.created_at.isoformat(),
        "read_at": record.read_at.isoformat() if record.read_at else None,
    }
