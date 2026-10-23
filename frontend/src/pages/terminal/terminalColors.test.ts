import { describe, expect, it } from "vitest";
import { createTerminalColorMapper } from "./terminalColors";

describe("terminal panel color adapter", () => {
  it("normalizes the dark and light RGB surfaces observed in Codex", () => {
    const mapper = createTerminalColorMapper();
    for (const [color, index] of [["32;35;50", 235], ["42;45;60", 236], ["249;249;249", 235], ["244;244;244", 236]]) {
      expect(mapper.transform(`\x1b[48;2;${color}mPrompt\x1b[K`)).toBe(`\x1b[48;5;${index}mPrompt\x1b[K`);
    }
  });

  it("adapts indexed/basic backgrounds while retaining foregrounds, attributes and colored backgrounds", () => {
    const mapper = createTerminalColorMapper();
    expect(mapper.transform("\x1b[1;38;2;40;48;58;48;2;244;244;244;4mText\x1b[0m"))
      .toBe("\x1b[1;38;2;40;48;58;48;5;236;4mText\x1b[0m");
    expect(mapper.transform("\x1b[38;5;255;48;5;255mWhite panel\x1b[49m"))
      .toBe("\x1b[38;5;255;48;5;236mWhite panel\x1b[49m");
    expect(mapper.transform("\x1b[40mA\x1b[47mB\x1b[107mC"))
      .toBe("\x1b[48;5;235mA\x1b[48;5;236mB\x1b[48;5;235mC");
    const untouched = "\x1b[38;2;249;249;249;58;2;48;40;47mFG\x1b[48;2;80;20;20mRed\x1b[48;2;128;128;128mGray\x1b[41mRed";
    expect(mapper.transform(untouched)).toBe(untouched);
  });

  it("supports colon RGB/index operands and C1 CSI", () => {
    const mapper = createTerminalColorMapper();
    expect(mapper.transform("\x1b[38:2::48:40:47;48:2::249:249:249mA\x1b[48:2:0:42:45:60mB\x9b48:5:255mC"))
      .toBe("\x1b[38:2::48:40:47;48;5;235mA\x1b[48;5;236mB\x9b48;5;236mC");
  });

  it("preserves OSC/DCS/APC payloads, hyperlinks, queries and text across every chunk boundary", () => {
    const opaque = "\x1b]0;title\x1b[48;2;249;249;249m\x07" +
      "\x1bPtmux;\x1b\x1b[48;2;249;249;249m\x1b\\" +
      "\x1b_Gpayload\x1b[48;5;255m\x1b\\" +
      "\x9d8;;https://example.test/\x9cLink\x1b]8;;\x1b\\";
    const source = opaque + "\x1b[?2026h\x1b[H\x1b[38;2;48;40;47;48;2;32;35;50m中文 😀\x1b[0m\x1b[?2026l\x1b]11;?\x07";
    const expected = source.replace("48;2;32;35;50m", "48;5;235m");
    for (let split = 0; split <= source.length; split++) {
      const mapper = createTerminalColorMapper();
      expect(mapper.transform(source.slice(0, split)) + mapper.transform(source.slice(split))).toBe(expected);
    }
    const mapper = createTerminalColorMapper();
    expect([...source].map(char => mapper.transform(char)).join("")).toBe(expected);
  });

  it("bounds incomplete sequences and resets state at a replay boundary", () => {
    const mapper = createTerminalColorMapper();
    const oversized = "\x1b[" + "0;".repeat(600) + "48;2;249;249;249m";
    expect(mapper.transform(oversized)).toBe(oversized);
    expect(mapper.transform("\x1b[48;2;249;")).toBe("");
    mapper.reset();
    expect(mapper.transform("Replay\x1b[48;2;244;244;244m")).toBe("Replay\x1b[48;5;236m");
    mapper.transform("\x1b]unfinished");
    mapper.reset();
    expect(mapper.transform("\x1b[48;2;249;249;249m")).toBe("\x1b[48;5;235m");
  });

  it("passes malformed colors, cancelled CSI and unsupported color spaces through", () => {
    const source = "\x1b[48;2;249;249m\x1b[48;2;256;249;249m\x1b[48:2:1:249:249:249m\x1b[48;2;\x18Text";
    expect(createTerminalColorMapper().transform(source)).toBe(source);
  });
});
