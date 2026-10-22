"""A shared, bounded foreground scheduling probe for the gateway process."""
from __future__ import annotations

import asyncio
import time
from collections import deque


class EventLoopLag:
    def __init__(self) -> None:
        self.samples: deque[tuple[float, float]] = deque(maxlen=64)

    def maximum_ms(self) -> float | None:
        now = time.monotonic()
        while self.samples and self.samples[0][0] < now - 5:
            self.samples.popleft()
        return round(max(value for _, value in self.samples), 1) if self.samples else None

    async def run(self) -> None:
        while True:
            started = time.monotonic()
            await asyncio.sleep(0.1)
            now = time.monotonic()
            self.samples.append((now, max(0, (now - started - 0.1) * 1000)))
