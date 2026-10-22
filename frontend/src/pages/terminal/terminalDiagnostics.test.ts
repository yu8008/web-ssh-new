import { afterEach, expect, it, vi } from "vitest";
import { createBrowserLagMonitor } from "./terminalDiagnostics";

afterEach(() => vi.useRealTimers());

it("distinguishes browser stalls and render waits, and excludes hidden-tab throttling", () => {
  vi.useFakeTimers();
  let now = 0;
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const view = { document: doc, performance: { now: () => now }, setInterval, clearInterval } as unknown as Window;
  const monitor = createBrowserLagMonitor(view);
  monitor.parsed(); now = 16; monitor.rendered();
  expect(monitor.renderWaitMs()).toBe(16);
  now = 350; vi.advanceTimersByTime(100);
  expect(monitor.maximumMs()).toBe(250);
  doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange"));
  now = 5000; vi.advanceTimersByTime(1000);
  doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange"));
  expect(monitor.maximumMs()).toBe(0);
  expect(monitor.renderWaitMs()).toBeUndefined();
  monitor.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
