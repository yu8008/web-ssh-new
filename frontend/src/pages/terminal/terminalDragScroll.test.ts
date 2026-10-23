import { describe, expect, it } from "vitest";
import { terminalDragScroll } from "./terminalDragScroll";

describe("drag edge speed", () => {
  it("reaches 240 lines/s at either boundary without leaving the terminal", () => {
    for (const rowHeight of [16, 23, 30]) {
      const bottom = 100 + rowHeight * 32;
      expect(terminalDragScroll(100, 100, bottom, 32).speed).toBe(240);
      expect(terminalDragScroll(bottom, 100, bottom, 32).speed).toBe(240);
      expect(terminalDragScroll(bottom + 100, 100, bottom, 32).speed).toBe(240);
    }
  });

  it("keeps a precise inner edge and gradually accelerates a sustained outer hold", () => {
    const at = (y: number, held = 0) => terminalDragScroll(y, 0, 736, 32, 48, held);
    expect(at(400, 2000).speed).toBe(0);
    expect(at(691).speed).toBeGreaterThan(32);
    expect(at(691).speed).toBeLessThan(50);
    expect(at(713, 2000).speed).toBe(at(713).speed);
    expect(at(736, 400).speed).toBe(240);
    expect(at(736, 600).speed).toBe(300);
    expect(at(736, 800).speed).toBe(360);
    expect(at(736, 10000).speed).toBe(360);
  });

  it("uses the same curve in both directions and with a narrower column edge", () => {
    for (const edge of [12, 48]) for (const held of [0, 600, 1000]) for (const distance of [0, 4, 10, 20, 60]) {
      const top = terminalDragScroll(100 + distance, 100, 836, 32, edge, held);
      const bottom = terminalDragScroll(836 - distance, 100, 836, 32, edge, held);
      expect(top.speed).toBe(bottom.speed);
      expect(top.direction + bottom.direction).toBe(0);
    }
    expect(terminalDragScroll(NaN, 0, 736, 32).speed).toBe(0);
    expect(terminalDragScroll(10, 10, 10, 32).speed).toBe(0);
  });
});
