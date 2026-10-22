import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalOutput, decodeTerminalOutput } from "./terminalOutput";

afterEach(() => vi.useRealTimers());

describe("terminal output scheduling", () => {
  it("coalesces packets with completion callbacks while preserving every callback and replay barrier", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const completed: number[] = [];
    const writer = createTerminalOutput({
      onOverflow: vi.fn(),
      write(data, done) { writes.push(data); setTimeout(done, 0); },
    });
    const packets = Array.from({ length: 300 }, (_, index) => `${index}: 中文😀 ${"x".repeat(100)}\r\n`);
    packets.forEach((packet, index) => writer.enqueue(packet, () => completed.push(index)));
    writer.enqueue("", () => completed.push(-1));
    writer.enqueue("after replay", () => completed.push(-2));
    vi.runAllTimers();
    expect(writes.join("")).toBe(packets.join("") + "after replay");
    expect(completed).toEqual([...packets.map((_, index) => index), -1, -2]);
    expect(writes.length).toBeLessThanOrEqual(5);
    writer.dispose();
  });

  it("coalesces tiny chunks, preserves control sequences and waits for parsing", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const parsed: Array<() => void> = [];
    const complete = vi.fn();
    const writer = createTerminalOutput({ chunkSize: 8, onOverflow: vi.fn(), write(data, done) { writes.push(data); parsed.push(done); } });
    ["\x1b[", "31m", "中", "文😀", "\x1b[0m"].forEach((part) => writer.enqueue(part));
    writer.enqueue("", complete);
    vi.runOnlyPendingTimers();
    expect(writes).toHaveLength(1);
    expect(complete).not.toHaveBeenCalled();
    for (let turn = 0; turn < 10 && !complete.mock.calls.length; turn++) {
      while (parsed.length) parsed.shift()!();
      vi.runAllTimers();
    }
    expect(writes.join("")).toBe("\x1b[31m中文😀\x1b[0m");
    expect(complete).toHaveBeenCalledOnce();
    writer.dispose();
  });

  it("yields during sustained output instead of draining an unbounded burst", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const writer = createTerminalOutput({ chunkSize: 2, onOverflow: vi.fn(), write(data, done) { writes.push(data); done(); } });
    writer.enqueue("x".repeat(100));
    expect(writes.length).toBeLessThanOrEqual(8);
    vi.runAllTimers();
    expect(writes.join("")).toBe("x".repeat(100));
    writer.dispose();
  });

  it("starts an idle keyboard echo without an extra timer", () => {
    vi.useFakeTimers();
    const write = vi.fn((_data: string, done: () => void) => done());
    const writer = createTerminalOutput({ write, onOverflow: vi.fn() });
    writer.enqueue("typed character");
    expect(write).toHaveBeenCalledOnce();
    writer.dispose();
  });

  it("yields to a pending input even while output fits the normal time budget", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const writer = createTerminalOutput({ chunkSize: 2, inputPending: () => true, onOverflow: vi.fn(),
      write(data, done) { writes.push(data); done(); } });
    writer.enqueue("abcdef");
    expect(writes).toEqual(["ab"]);
    vi.runAllTimers();
    expect(writes.join("")).toBe("abcdef");
    expect(writer.diagnostics().queuedChars).toBe(0);
    writer.dispose();
  });

  it("replaces pending history only after the active parse completes", () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let parsed = () => {};
    const writer = createTerminalOutput({ chunkSize: 3, onOverflow: vi.fn(), write(data, done) { events.push(data); parsed = done; } });
    writer.enqueue("oldpending");
    vi.runOnlyPendingTimers();
    writer.replacePending(() => events.push("reset"));
    writer.enqueue("new");
    parsed();
    vi.runAllTimers();
    parsed();
    expect(events).toEqual(["old", "reset", "new"]);
    writer.dispose();
  });

  it("signals overflow once and recovers through an explicit replay reset", () => {
    vi.useFakeTimers();
    const overflow = vi.fn();
    const writes: string[] = [];
    const writer = createTerminalOutput({ maxQueuedChars: 4, onOverflow: overflow, write(data, done) { writes.push(data); done(); } });
    writer.enqueue("too large");
    writer.enqueue("ignored");
    expect(overflow).toHaveBeenCalledOnce();
    writer.replacePending(() => writes.push("reset"));
    writer.enqueue("new");
    vi.runAllTimers();
    expect(writes).toEqual(["reset", "new"]);
    writer.dispose();
  });

  it("does not run queued callbacks after disposal", () => {
    vi.useFakeTimers();
    let parsed = () => {};
    const complete = vi.fn();
    const writer = createTerminalOutput({ onOverflow: vi.fn(), write(_data, done) { parsed = done; } });
    writer.enqueue("data", complete);
    vi.runAllTimers();
    writer.dispose();
    parsed();
    expect(complete).not.toHaveBeenCalled();
  });
});

it("validates framed output without confusing malformed data with control frames", () => {
  expect(decodeTerminalOutput('{"type":"pong","ping_id":7}')).toEqual({ type: "pong", ping_id: 7 });
  expect(decodeTerminalOutput('{"type":"pong","ping_id":7,"gateway_queue_ms":5,"gateway_loop_lag_ms":-1,"gateway_queued_chars":null}'))
    .toEqual({ type: "pong", ping_id: 7, gateway_queue_ms: 5 });
  expect(decodeTerminalOutput('{"type":"output","seq":1,"data":"中文"}')).toEqual({ type: "output", seq: 1, data: "中文" });
  for (const data of ["hello", "null", '{"type":"output","seq":-1,"data":"x"}', '{"type":"replay_end","seq":"1"}']) expect(decodeTerminalOutput(data)).toBeNull();
});
