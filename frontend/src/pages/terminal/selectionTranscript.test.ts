import { describe, expect, it } from "vitest";
import type { Terminal } from "xterm";
import { captureSelectionRows, SelectionTranscript, type SelectionRow } from "./selectionTranscript";

const row = (text: string, wrapped = false): SelectionRow => ({
  text, wrapped, offsets: Array.from({ length: 81 }, (_, index) => index),
});
const frame = (...text: string[]) => text.map((value) => row(value));

it("reuses column offsets across moved rows without sharing duplicate row identities", () => {
  let reads = 0;
  let lines = ["ABCD", "WXYZ", "    "];
  const term = {
    rows: 3, cols: 4,
    buffer: { active: {
      viewportY: 0,
      getNullCell: () => ({}),
      getLine: (index: number) => ({
        isWrapped: false,
        translateToString: () => lines[index].trimEnd(),
        getCell: (col: number) => {
          reads++;
          return { getChars: () => lines[index][col], getWidth: () => 1 };
        },
      }),
    } },
  } as unknown as Terminal;
  const first = captureSelectionRows(term);
  expect(reads).toBe(12);
  lines = ["WXYZ", "    ", "    "];
  const next = captureSelectionRows(term, first);
  expect(reads).toBe(12);
  expect(next[0].offsets).toBe(first[1].offsets);
  expect(next[1]).not.toBe(next[2]);
  expect(next[1].offsets).toBe(next[2].offsets);
  const selection = new SelectionTranscript(next, { row: 0, col: 0 });
  selection.move({ row: 2, col: 4 });
  expect(selection.getText()).toBe("WXYZ\n\n");
});

describe("TUI selection transcript", () => {
  it("keeps an offscreen anchor in the full animation range while clipping native selection", () => {
    const selection = new SelectionTranscript(frame("H", "A", "B", "C", "F"), { row: 1, col: 2 });
    selection.scroll(frame("H", "B", "C", "D", "F"), 1);
    selection.scroll(frame("H", "C", "D", "E", "F"), 1);
    selection.move({ row: 4, col: 80 });
    expect(selection.getVisibleRange()).toEqual({ start: { row: 1, col: 0 }, end: { row: 4, col: 80 } });
    expect(selection.getScrollRange()).toEqual({ start: { row: -1, col: 2 }, end: { row: 4, col: 80 } });
  });

  it("keeps the lower anchor beyond the viewport when animating an upward selection", () => {
    const selection = new SelectionTranscript(frame("H", "C", "D", "E", "F"), { row: 3, col: 1 });
    selection.scroll(frame("H", "B", "C", "D", "F"), -1);
    selection.scroll(frame("H", "A", "B", "C", "F"), -1);
    selection.move({ row: 0, col: 0 });
    expect(selection.getScrollRange()).toEqual({ start: { row: 0, col: 0 }, end: { row: 5, col: 1 } });
  });

  for (const direction of [-1, 1] as const) {
    it(`retains 9,010 consecutive rows during a long ${direction < 0 ? "upward" : "downward"} drag`, () => {
      const visible = (offset: number) => frame("Header", ...Array.from({ length: 10 }, (_, index) =>
        `Line ${String(offset + index).padStart(5, "0")}`.padEnd(70, ".")), "Footer");
      const initial = direction < 0 ? 9000 : 0;
      const selection = new SelectionTranscript(visible(initial), { row: direction < 0 ? 10 : 1, col: direction < 0 ? 80 : 0 });
      for (let distance = 2; distance <= 9000; distance += 2) {
        expect(selection.scroll(visible(initial + distance * direction), direction)).toBe("moved");
        selection.move({ row: direction < 0 ? 1 : 10, col: direction < 0 ? 0 : 80 });
      }
      const lines = selection.getText().split("\n");
      expect(lines).toHaveLength(9010);
      expect(lines.every((line, index) => line === `Line ${String(index).padStart(5, "0")}`.padEnd(70, "."))).toBe(true);
    }, 10000);
  }

  it("keeps scrolling when a known multiline footer changes during output", () => {
    const selection = new SelectionTranscript(frame("H", "A", "B", "C", "D", "status", "prompt", "F"), { row: 1, col: 0 });
    expect(selection.scroll(frame("H", "B", "C", "D", "E", "status", "prompt", "F"), 1)).toBe("moved");
    expect(selection.scroll(frame("H", "C", "D", "E", "F", "running", "new prompt", "F"), 1)).toBe("moved");
    selection.move({ row: 7, col: 80 });
    expect(selection.getText()).toBe("A\nB\nC\nD\nE\nF\nstatus\nprompt\nF");
  });

  it("accepts a complete scroll with changing chrome before any region is known", () => {
    const selection = new SelectionTranscript(frame("H", "A", "B", "C", "D", "status", "prompt", "F"), { row: 1, col: 0 });
    expect(selection.scroll(frame("H", "B", "C", "D", "E", "running", "new prompt", "F"), 1, true)).toBe("moved");
    expect(selection.scrollMotion).toEqual({ top: 1, bottom: 5, lines: 1 });
  });

  it("can learn the body while a multiline prompt changes from the very first scroll", () => {
    const visible = (offset: number) => frame("H", ...Array.from({ length: 8 }, (_, index) => `Line ${offset + index}`), `Status ${offset}`, `Prompt ${offset}`, "F");
    const selection = new SelectionTranscript(visible(0), { row: 1, col: 0 });
    expect(selection.scroll(visible(2), 1)).toBe("moved");
    expect(selection.scrollMotion).toEqual({ top: 1, bottom: 9, lines: 2 });
    selection.move({ row: 8, col: 80 });
    expect(selection.getText()).toBe(Array.from({ length: 10 }, (_, index) => `Line ${index}`).join("\n"));
  });

  it("still rejects a partial body repaint after learning the prompt boundaries", () => {
    const selection = new SelectionTranscript(frame("H", "A", "B", "C", "D", "status", "prompt", "F"), { row: 1, col: 0 });
    expect(selection.scroll(frame("H", "B", "C", "D", "E", "status", "prompt", "F"), 1)).toBe("moved");
    expect(selection.scroll(frame("H", "C", "D", "D", "E", "running", "new prompt", "F"), 1)).toBe("unmatched");
    expect(selection.scroll(frame("H", "C", "D", "E", "F", "running", "new prompt", "F"), 1)).toBe("moved");
    selection.move({ row: 4, col: 80 });
    expect(selection.getText()).toBe("A\nB\nC\nD\nE\nF");
  });

  it("keeps selected text across remote repaints and includes fixed chrome once", () => {
    const selection = new SelectionTranscript(frame("header", "line 1", "line 2", "line 3", "footer"), { row: 1, col: 0 });
    selection.move({ row: 4, col: 80 });
    expect(selection.scroll(frame("header", "line 2", "line 3", "line 4", "footer"), 1)).toBe("moved");
    expect(selection.scrollMotion).toEqual({ top: 1, bottom: 4, lines: 1 });
    selection.move({ row: 4, col: 80 });
    expect(selection.scroll(frame("header", "line 3", "line 4", "line 5", "footer changed"), 1)).toBe("moved");
    selection.move({ row: 4, col: 80 });
    expect(selection.getText()).toBe("line 1\nline 2\nline 3\nline 4\nline 5\nfooter");
  });

  it("scrolls upwards, then reverses without duplicating previously captured rows", () => {
    const selection = new SelectionTranscript(frame("header", "line 3", "line 4", "line 5", "footer"), { row: 3, col: 6 });
    expect(selection.scroll(frame("header", "line 2", "line 3", "line 4", "footer"), -1)).toBe("moved");
    expect(selection.scrollMotion).toEqual({ top: 1, bottom: 4, lines: -1 });
    selection.move({ row: 1, col: 0 });
    expect(selection.getText()).toBe("line 2\nline 3\nline 4\nline 5");
    expect(selection.scroll(frame("header", "line 3", "line 4", "line 5", "footer"), 1)).toBe("moved");
    selection.move({ row: 1, col: 0 });
    expect(selection.getText()).toBe("line 3\nline 4\nline 5");
    expect(selection.scroll(frame("header", "line 2", "line 3", "line 4", "footer"), -1)).toBe("moved");
    selection.move({ row: 1, col: 0 });
    expect(selection.getText()).toBe("line 2\nline 3\nline 4\nline 5");
  });

  it("does not replace verified text with an unrelated or partial repaint", () => {
    const selection = new SelectionTranscript(frame("header", "original 1", "original 2", "original 3"), { row: 1, col: 0 });
    selection.move({ row: 3, col: 80 });
    const original = selection.getText();
    expect(selection.scroll(frame("header", "new 1", "new 2", "new 3"), 1)).toBe("unmatched");
    expect(selection.scrollMotion).toBeNull();
    expect(selection.getText()).toBe(original);
    expect(selection.scroll(frame("header", "original 2", "original 3", "original 4"), 1)).toBe("moved");
    selection.move({ row: 3, col: 80 });
    expect(selection.getText()).toBe("original 1\noriginal 2\noriginal 3\noriginal 4");
  });

  it("does not infer a scroll from blank or repeated rows", () => {
    const selection = new SelectionTranscript(frame("", "same", "same", ""), { row: 1, col: 0 });
    selection.move({ row: 2, col: 4 });
    expect(selection.scroll(frame("", "same", "", ""), 1)).toBe("unmatched");
    expect(selection.getText()).toBe("same\nsame");
  });

  it("waits for a partial repaint instead of inserting old rows twice", () => {
    const selection = new SelectionTranscript(frame("H", "A", "B", "C", "D", "F"), { row: 1, col: 0 });
    selection.move({ row: 5, col: 80 });
    expect(selection.scroll(frame("H", "B", "C", "C", "D", "F"), 1)).toBe("unmatched");
    expect(selection.getText()).toBe("A\nB\nC\nD\nF");
    expect(selection.scroll(frame("H", "B", "C", "D", "E", "F"), 1)).toBe("moved");
    selection.move({ row: 5, col: 80 });
    expect(selection.getText()).toBe("A\nB\nC\nD\nE\nF");
  });

  it("continues when a newly revealed line repeats earlier visible text", () => {
    const selection = new SelectionTranscript(frame("H", "A", "B", "C", "D", "F"), { row: 1, col: 0 });
    expect(selection.scroll(frame("H", "B", "C", "D", "B", "F"), 1)).toBe("moved");
    selection.move({ row: 5, col: 80 });
    expect(selection.getText()).toBe("A\nB\nC\nD\nB\nF");
  });

  it("continues when a new output row repeats fixed header text", () => {
    const selection = new SelectionTranscript(frame("H", "A", "B", "C", "D", "F"), { row: 1, col: 0 });
    expect(selection.scroll(frame("H", "B", "C", "D", "H", "F"), 1)).toBe("moved");
    selection.move({ row: 5, col: 80 });
    expect(selection.getText()).toBe("A\nB\nC\nD\nH\nF");
  });

  it("accepts repeated rows at the entering edge after a synchronized repaint completes", () => {
    const selection = new SelectionTranscript(frame("H", "A", "B", "C", "D", "F"), { row: 1, col: 0 });
    const next = frame("H", "B", "C", "D", "D", "F");
    expect(selection.scroll(next, 1)).toBe("unmatched");
    expect(selection.scroll(next, 1, true)).toBe("moved");
    selection.move({ row: 5, col: 80 });
    expect(selection.getText()).toBe("A\nB\nC\nD\nD\nF");
  });

  it("keeps partial upward repaint protection while allowing legitimate repeated output", () => {
    const selection = new SelectionTranscript(frame("H", "B", "C", "D", "E", "F"), { row: 4, col: 1 });
    expect(selection.scroll(frame("H", "B", "B", "C", "E", "F"), -1)).toBe("unmatched");
    expect(selection.scroll(frame("H", "D", "B", "C", "D", "F"), -1)).toBe("moved");
    selection.move({ row: 1, col: 0 });
    expect(selection.getText()).toBe("D\nB\nC\nD\nE");
  });

  it("preserves cell offsets for CJK/emoji and joins wrapped lines", () => {
    const wide = { text: "中😀é", wrapped: false, offsets: [0, 1, 1, 3, 3, 5] };
    const selection = new SelectionTranscript([wide, row(" continuation", true)], { row: 0, col: 1 });
    selection.move({ row: 1, col: 13 });
    expect(selection.getText()).toBe("😀é continuation");
  });

  it("captures rectangular selection with Alt", () => {
    const selection = new SelectionTranscript(frame("abc 123", "def 456", "ghi 789"), { row: 0, col: 4 }, true);
    selection.move({ row: 2, col: 7 });
    expect(selection.getText()).toBe("123\n456\n789");
  });

  it("invalidates lazy copy text only when the selection or captured rows change", () => {
    const selection = new SelectionTranscript(frame("one", "two", "three"), { row: 0, col: 0 });
    expect(selection.hasSelection()).toBe(false);
    selection.move({ row: 2, col: 5 });
    expect(selection.hasSelection()).toBe(true);
    expect(selection.getText()).toBe("one\ntwo\nthree");
    selection.scroll(frame("two", "three", "four"), 1);
    selection.move({ row: 2, col: 4 });
    expect(selection.getText()).toBe("one\ntwo\nthree\nfour");
    selection.move({ row: 0, col: 1 });
    expect(selection.getText()).toBe("one\nt");
    expect(selection.getText()).toBe("one\nt");
  });

  it("does not advertise empty selections in trailing whitespace", () => {
    const selection = new SelectionTranscript(frame("", "words"), { row: 0, col: 0 });
    selection.move({ row: 0, col: 8 });
    expect(selection.hasSelection()).toBe(false);
    expect(selection.getText()).toBe("");
    selection.move({ row: 1, col: 2 });
    expect(selection.hasSelection()).toBe(true);
    expect(selection.getText()).toBe("\nwo");
  });

  it("highlights only the visible part when the anchor has scrolled offscreen", () => {
    const selection = new SelectionTranscript(frame("header", "line 1", "line 2", "line 3", "footer"), { row: 1, col: 2 });
    selection.scroll(frame("header", "line 2", "line 3", "line 4", "footer"), 1);
    selection.move({ row: 3, col: 3 });
    expect(selection.getVisibleRange()).toEqual({ start: { row: 1, col: 0 }, end: { row: 3, col: 3 } });
    expect(selection.getText()).toBe("ne 1\nline 2\nline 3\nlin");
  });

  it("stops capturing at the memory limit while retaining existing text", () => {
    const selection = new SelectionTranscript(frame("first", "second", "third"), { row: 0, col: 0 });
    selection.move({ row: 2, col: 5 });
    const original = selection.getText();
    expect(selection.scroll(frame("second", "third", "x".repeat(1024 * 1024)), 1)).toBe("limit");
    expect(selection.getText()).toBe(original);
  });
});
