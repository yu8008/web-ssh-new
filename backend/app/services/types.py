from __future__ import annotations

from dataclasses import dataclass, field
from collections import deque
from datetime import datetime
from typing import Protocol

from app.core.db import utc_now
from app.services.terminal_modes import TerminalModes


@dataclass
class SessionOutput:
    data: str
    timestamp: datetime
    seq: int = 0
    byte_size: int = field(init=False)

    def __post_init__(self) -> None:
        self.byte_size = len(self.data.encode("utf-8"))


@dataclass
class PtyInfo:
    term: str
    rows: int
    cols: int


class SessionHandle(Protocol):
    session_id: str

    async def send(self, data: str) -> None:
        ...

    async def resize(self, rows: int, cols: int) -> None:
        ...

    async def close(self) -> None:
        ...


@dataclass
class SessionBuffer:
    max_lines: int = 4000
    max_bytes: int = 8 * 1024 * 1024
    lines: deque[SessionOutput] | list[SessionOutput] | None = None
    total_bytes: int = 0
    sequence: int = 0
    modes: TerminalModes = field(default_factory=TerminalModes, init=False, repr=False)

    def __post_init__(self) -> None:
        self.lines = deque(self.lines or ())
        for item in self.lines:
            self.modes.feed(item.data)
            self.sequence += 1
            item.seq = self.sequence
        self.total_bytes = sum(len(item.data.encode("utf-8")) for item in self.lines)

    def append(self, data: str) -> SessionOutput:
        self.modes.feed(data)
        self.sequence += 1
        output = SessionOutput(data=data, timestamp=utc_now(), seq=self.sequence)
        self.lines.append(output)
        self.total_bytes += output.byte_size
        while len(self.lines) > self.max_lines or self.total_bytes > self.max_bytes:
            removed = self.lines.popleft()
            self.total_bytes -= removed.byte_size
        return output

    def dump(self) -> list[SessionOutput]:
        return list(self.lines)
