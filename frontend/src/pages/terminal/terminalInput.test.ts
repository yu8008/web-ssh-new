import { describe, expect, it } from "vitest";
import { createTerminalInputWriter } from "./terminalInput";

function setup() {
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const view = {
    requestAnimationFrame(callback: FrameRequestCallback) { callbacks.set(++nextId, callback); return nextId; },
    cancelAnimationFrame(id: number) { callbacks.delete(id); },
  } as Window;
  const packets: string[] = [];
  const writer = createTerminalInputWriter(view, (data) => packets.push(data));
  return { writer, packets, frame: () => { for (const callback of [...callbacks.values()]) callback(0); } };
}

describe("terminal wheel input batching", () => {
  it("preserves wheel reports and modifiers while sending one packet per frame", () => {
    const { writer, packets, frame } = setup();
    const reports = ["\x1b[<64;12;8M", "\x1b[<65;12;8M", "\x1b[<80;12;8M"];
    reports.forEach(writer.write);
    expect(packets).toEqual([]);
    frame();
    expect(packets).toEqual([reports.join("")]);
  });

  it("flushes a pending scroll before a key or mouse click", () => {
    const { writer, packets, frame } = setup();
    writer.write("\x1b[<64;12;8M");
    writer.write("x");
    writer.write("\x1b[<65;12;8M");
    writer.write("\x1b[<0;12;8M");
    frame();
    expect(packets).toEqual(["\x1b[<64;12;8M", "x", "\x1b[<65;12;8M", "\x1b[<0;12;8M"]);
  });

  it("cancels pending reports when the terminal is disposed", () => {
    const { writer, packets, frame } = setup();
    writer.write("\x1b[<64;12;8M");
    writer.dispose();
    frame();
    expect(packets).toEqual([]);
  });

  it("sends a selection scroll immediately without leaving a duplicate frame callback", () => {
    const { writer, packets, frame } = setup();
    writer.write("\x1b[<65;12;8M");
    writer.flush();
    expect(packets).toEqual(["\x1b[<65;12;8M"]);
    frame();
    expect(packets).toHaveLength(1);
    writer.write("\x1b[<64;12;8M");
    frame();
    expect(packets).toEqual(["\x1b[<65;12;8M", "\x1b[<64;12;8M"]);
  });
});
