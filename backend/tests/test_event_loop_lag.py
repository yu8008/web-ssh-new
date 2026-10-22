import asyncio

from app.services.event_loop_lag import EventLoopLag


def test_monitor_discards_old_stalls_and_reports_no_sample_before_start(monkeypatch):
    monkeypatch.setattr("app.services.event_loop_lag.time.monotonic", lambda: 10)
    monitor = EventLoopLag()
    assert monitor.maximum_ms() is None
    monitor.samples.extend([(4, 300), (8, 12), (9, 4)])
    assert monitor.maximum_ms() == 12
    assert len(monitor.samples) == 2


def test_monitor_can_stop_without_leaving_a_task():
    async def scenario():
        monitor = EventLoopLag()
        task = asyncio.create_task(monitor.run())
        await asyncio.sleep(0.12)
        assert monitor.maximum_ms() is not None
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert task.cancelled()
    asyncio.run(scenario())
