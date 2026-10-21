from __future__ import annotations

import asyncio

from app.services.terminal_resize import TerminalResizeQueue


def test_disconnect_cancels_resize_and_discards_pending_sizes() -> None:
    async def scenario() -> None:
        started = asyncio.Event()
        cancelled = asyncio.Event()
        sizes = []

        async def apply(rows, cols):
            sizes.append((rows, cols))
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        queue = TerminalResizeQueue(apply)
        queue.request(30, 80)
        await asyncio.wait_for(started.wait(), 1)
        queue.request(40, 120)
        await asyncio.wait_for(queue.close(), 1)
        queue.request(50, 160)
        await asyncio.sleep(0)
        assert cancelled.is_set()
        assert sizes == [(30, 80)]
        assert queue.task.done()

    asyncio.run(scenario())


def test_failed_resize_does_not_block_the_next_size() -> None:
    async def scenario() -> None:
        started = asyncio.Event()
        release = asyncio.Event()
        applied = asyncio.Event()
        sizes = []

        async def apply(rows, cols):
            sizes.append((rows, cols))
            if len(sizes) == 1:
                started.set()
                await release.wait()
                raise RuntimeError("SSH resize failed")
            applied.set()

        queue = TerminalResizeQueue(apply)
        try:
            queue.request(30, 80)
            await asyncio.wait_for(started.wait(), 1)
            queue.request(40, 120)
            release.set()
            await asyncio.wait_for(applied.wait(), 1)
            assert sizes == [(30, 80), (40, 120)]
        finally:
            await queue.close()

    asyncio.run(scenario())
