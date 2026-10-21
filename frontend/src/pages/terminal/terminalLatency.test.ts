import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalLatencyProbe } from "./terminalLatency";

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  let now = 0;
  const document = { visibilityState: "visible" };
  const view = {
    document,
    performance: { now: () => now },
    setInterval: windowlessSetInterval,
    clearInterval: windowlessClearInterval,
  } as unknown as Window;
  const send = vi.fn();
  const sample = vi.fn();
  const probe = createTerminalLatencyProbe(view, send, sample);
  return { probe, send, sample, document, advance: (ms: number) => { now += ms; vi.advanceTimersByTime(ms); } };
}

function windowlessSetInterval(callback: () => void, ms: number) { return setInterval(callback, ms); }
function windowlessClearInterval(timer: ReturnType<typeof setInterval>) { clearInterval(timer); }

describe("terminal connection latency", () => {
  it("measures only a matching reply and ignores stale or duplicate pongs", () => {
    const { probe, send, sample, advance } = setup();
    expect(send).toHaveBeenLastCalledWith(1);
    advance(315);
    probe.pong(99);
    expect(sample).not.toHaveBeenCalled();
    probe.pong(1);
    expect(sample).toHaveBeenLastCalledWith(315);
    probe.pong(1);
    expect(sample).toHaveBeenCalledTimes(1);
    probe.dispose();
    advance(15000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps one probe in flight and clears a stale value when it times out", () => {
    const { probe, send, sample, advance } = setup();
    advance(10000);
    expect(send).toHaveBeenCalledTimes(1);
    advance(5000);
    expect(sample).toHaveBeenLastCalledWith(null);
    expect(send).toHaveBeenLastCalledWith(2);
    probe.pong(1);
    expect(sample).toHaveBeenCalledTimes(1);
    advance(60);
    probe.pong(2);
    expect(sample).toHaveBeenLastCalledWith(60);
    probe.dispose();
  });

  it("does not report background tab throttling as network latency", () => {
    const { probe, send, sample, document, advance } = setup();
    document.visibilityState = "hidden";
    advance(3000);
    probe.pong(1);
    expect(sample).toHaveBeenLastCalledWith(null);
    advance(2000);
    expect(send).toHaveBeenCalledTimes(1);
    document.visibilityState = "visible";
    advance(5000);
    expect(send).toHaveBeenLastCalledWith(2);
    probe.dispose();
  });
});
