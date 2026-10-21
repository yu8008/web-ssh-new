import { describe, expect, it } from "vitest";
import { SelectionTranscript, type SelectionRow } from "./selectionTranscript";

const row = (text: string, wrapped = false): SelectionRow => ({
  text, wrapped, offsets: Array.from({ length: 81 }, (_, index) => index),
});
const frame = (...text: string[]) => text.map((value) => row(value));

describe("TUI selection transcript", () => {
  it("keeps selected text across remote repaints and includes fixed chrome once", () => {
    const selection = new SelectionTranscript(frame("header", "line 1", "line 2", "line 3", "footer"), { row: 1, col: 0 });
    selection.move({ row: 4, col: 80 });
    expect(selection.scroll(frame("header", "line 2", "line 3", "line 4", "footer"), 1)).toBe("moved");
    selection.move({ row: 4, col: 80 });
    expect(selection.scroll(frame("header", "line 3", "line 4", "line 5", "footer changed"), 1)).toBe("moved");
    selection.move({ row: 4, col: 80 });
    expect(selection.getText()).toBe("line 1\nline 2\nline 3\nline 4\nline 5\nfooter");
  });

  it("scrolls upwards, then reverses without duplicating previously captured rows", () => {
    const selection = new SelectionTranscript(frame("header", "line 3", "line 4", "line 5", "footer"), { row: 3, col: 6 });
    expect(selection.scroll(frame("header", "line 2", "line 3", "line 4", "footer"), -1)).toBe("moved");
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
