"""Serialize terminal resizes without blocking keyboard input on SSH commands."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable


logger = logging.getLogger(__name__)


class TerminalResizeQueue:
    def __init__(self, apply: Callable[[int, int], Awaitable[None]]) -> None:
        self.apply = apply
        self.pending: tuple[int, int] | None = None
        self.task: asyncio.Task[None] | None = None
        self.closed = False

    def request(self, rows: int, cols: int) -> None:
        if self.closed:
            return
        self.pending = (rows, cols)
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while self.pending is not None:
            rows, cols = self.pending
            self.pending = None
            try:
                await self.apply(rows, cols)
            except Exception:
                logger.warning("Terminal resize failed rows=%s cols=%s", rows, cols, exc_info=True)

    async def close(self) -> None:
        self.closed = True
        self.pending = None
        if self.task is not None:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
