import type { IBufferCell, IBufferLine, Terminal } from "xterm";

export type SelectionPoint = { row: number; col: number };
export type SelectionRow = { text: string; wrapped: boolean; offsets: number[] };
export type SelectionScrollMotion = { top: number; bottom: number; lines: number };

export function captureSelectionRows(term: Terminal, previous: SelectionRow[] = []): SelectionRow[] {
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  const cachedOffsets = new Map(previous.filter((row) => row.offsets.length === term.cols + 1)
    .map((row) => [row.text, row.offsets]));
  return Array.from({ length: term.rows }, (_, index) => {
    const line = buffer.getLine(buffer.viewportY + index);
    const text = line?.translateToString(true).trimEnd() ?? "";
    const offsets = cachedOffsets.get(text);
    // Reuse immutable column offsets for unchanged/moved rows, but keep each
    // row's identity distinct so duplicate/blank lines remain selectable.
    if (offsets) return { text, wrapped: line?.isWrapped ?? false, offsets };
    return captureRow(line, term.cols, cell);
  });
}

function captureRow(line: IBufferLine | undefined, cols: number, reusableCell: IBufferCell): SelectionRow {
  let text = "";
  const offsets = [0];
  for (let col = 0; col < cols; col += 1) {
    const cell = line?.getCell(col, reusableCell);
    offsets[col] = text.length;
    if (cell?.getWidth() !== 0) {
      text += cell?.getChars() || " ";
    }
    offsets[col + 1] = text.length;
  }
  return { text: text.trimEnd(), wrapped: line?.isWrapped ?? false, offsets };
}

function sameRow(a: SelectionRow, b: SelectionRow): boolean {
  return a.text === b.text && a.wrapped === b.wrapped;
}

type ScrollMatch = { oldStart: number; newStart: number; length: number };

/** Find a moving block, ignoring stationary TUI headers/footers. Never guess a
 * displacement from blank/repeated rows alone: that could corrupt copied text. */
function findScrollMatch(previous: SelectionRow[], next: SelectionRow[], direction: number, complete: boolean,
  region: { top: number; bottom: number } | null): ScrollMatch | null {
  const previousCounts = new Map<string, number>();
  const nextCounts = new Map<string, number>();
  for (const row of previous) if (row.text.trim()) previousCounts.set(row.text, (previousCounts.get(row.text) ?? 0) + 1);
  for (const row of next) if (row.text.trim()) nextCounts.set(row.text, (nextCounts.get(row.text) ?? 0) + 1);
  let best: ScrollMatch | null = null;
  let bestScore = 0;
  let ambiguous = false;
  for (let distance = 1; distance < previous.length; distance += 1) {
    const delta = distance * direction;
    let start = 0;
    while (start < next.length) {
      const oldStart = start + delta;
      if (oldStart < 0 || oldStart >= previous.length || !sameRow(previous[oldStart], next[start])) {
        start += 1;
        continue;
      }
      let length = 0;
      const distinct = new Set<string>();
      let meaningful = 0;
      while (start + length < next.length && oldStart + length < previous.length &&
        sameRow(previous[oldStart + length], next[start + length])) {
        const text = next[start + length].text.trim();
        if (text) {
          meaningful += 1;
          distinct.add(text);
        }
        length += 1;
      }
      if (distinct.size >= 2) {
        const top = Math.min(oldStart, start);
        const bottom = Math.max(oldStart, start) + length;
        // A partial repaint leaves old rows at the entering edge while also
        // painting their shifted copies. Repeated text elsewhere (including
        // newly revealed output) is valid and must not stop a long selection.
        const enteringTop = direction > 0 ? start + length : oldStart;
        const enteringBottom = direction > 0 ? bottom : start;
        const staleEdge = !complete && next.slice(enteringTop, enteringBottom).some((row, offset) =>
          sameRow(row, previous[enteringTop + offset]) && previousCounts.get(row.text) === 1 &&
          (nextCounts.get(row.text) ?? 0) > 1);
        if (staleEdge) {
          start += Math.max(1, length);
          continue;
        }
        // A prompt/status area may occupy several rows and update independently
        // of the scrolling output. Once its bounds are verified, don't mistake
        // those updates for an incomplete body repaint. An explicit synchronized
        // repaint can establish new bounds without a preceding static frame.
        const knownRegion = region?.top === top && region?.bottom === bottom;
        // During live output there may never be a static prompt to learn from.
        // A majority-sized unique overlap with a fully replaced entering edge
        // also establishes the body. Keep the stale-edge check above: a half
        // repaint must never be accepted just because its prompt changed.
        const strongOverlap = length >= Math.ceil(next.length / 2) &&
          next.slice(enteringTop, enteringBottom).every((row, offset) => !sameRow(row, previous[enteringTop + offset]));
        const changedOutside = !complete && !knownRegion && !strongOverlap && next.some((row, index) =>
          (index < top || index >= bottom) && index > 0 && index < next.length - 1 && !sameRow(row, previous[index]));
        if (changedOutside) {
          start += Math.max(1, length);
          continue;
        }
        const score = meaningful * (previous.length + 1) + length;
        if (score > bestScore) {
          best = { oldStart, newStart: start, length };
          bestScore = score;
          ambiguous = false;
        } else if (score === bestScore) {
          ambiguous = true;
        }
      }
      start += Math.max(1, length);
    }
  }
  return ambiguous ? null : best;
}

/** Immutable rows outlive TUI repaints. Frame rows point into the captured
 * document, so scrolling back reuses rows and fixed chrome is included once. */
export class SelectionTranscript {
  scrollMotion: SelectionScrollMotion | null = null;
  private rows: SelectionRow[];
  private frame: SelectionRow[];
  private anchor: { row: SelectionRow; col: number };
  private end: { row: SelectionRow; col: number };
  private positions: Map<SelectionRow, number>;
  private cachedText: string | undefined;
  private cachedHasSelection: boolean | undefined;
  private capturedChars: number;
  private scrollRegion: { top: number; bottom: number } | null = null;

  constructor(frame: SelectionRow[], point: SelectionPoint, private readonly columnMode = false) {
    this.rows = [...frame];
    this.frame = [...frame];
    this.anchor = { row: frame[point.row], col: point.col };
    this.end = { ...this.anchor };
    this.positions = new Map(this.rows.map((row, index) => [row, index]));
    this.capturedChars = this.rows.reduce((size, row) => size + row.text.length + 1, 0);
  }

  move(point: SelectionPoint): boolean {
    if (this.end.row === this.frame[point.row] && this.end.col === point.col) return false;
    this.end = { row: this.frame[point.row], col: point.col };
    this.cachedText = undefined;
    this.cachedHasSelection = undefined;
    return true;
  }

  hasSelection(): boolean {
    if (this.cachedHasSelection !== undefined) return this.cachedHasSelection;
    const { start, end } = this.range();
    const left = Math.min(this.anchor.col, this.end.col);
    const right = Math.max(this.anchor.col, this.end.col);
    for (let index = start.row; index <= end.row; index += 1) {
      const row = this.rows[index];
      if (index > start.row && (this.columnMode || !row.wrapped)) return this.cachedHasSelection = true;
      const first = this.columnMode ? left : index === start.row ? start.col : 0;
      const last = this.columnMode ? right : index === end.row ? end.col : row.offsets.length - 1;
      if (Math.min(row.offsets[last] ?? row.text.length, row.text.length) >
          Math.min(row.offsets[first] ?? row.text.length, row.text.length)) return this.cachedHasSelection = true;
    }
    return this.cachedHasSelection = false;
  }

  scroll(next: SelectionRow[], direction: -1 | 1, complete = false): "moved" | "unchanged" | "unmatched" | "limit" {
    this.scrollMotion = null;
    if (next.length !== this.frame.length) return "unmatched";
    if (next.every((row, index) => sameRow(row, this.frame[index]))) return "unchanged";
    const match = findScrollMatch(this.frame, next, direction, complete, this.scrollRegion);
    if (!match) return "unmatched";
    const { oldStart, newStart, length } = match;
    const top = Math.min(oldStart, newStart);
    const bottom = Math.max(oldStart, newStart) + length;
    const mapped = [...this.frame];
    for (let index = 0; index < length; index += 1) {
      mapped[newStart + index] = this.frame[oldStart + index];
    }

    // Reuse already captured neighbours when reversing the scroll direction.
    // Stationary chrome outside the moving block must not become a neighbour.
    const fixed = new Set([...this.frame.slice(0, top), ...this.frame.slice(bottom)]);
    const document = [...this.rows];
    let firstInserted = document.length;
    let addedChars = 0;
    if (direction > 0) {
      let position = document.indexOf(mapped[newStart + length - 1]) + 1;
      for (let index = newStart + length; index < bottom; index += 1) {
        const existing = document[position];
        if (existing && !fixed.has(existing) && sameRow(existing, next[index])) {
          mapped[index] = existing;
        } else {
          mapped[index] = next[index];
          firstInserted = Math.min(firstInserted, position);
          addedChars += next[index].text.length + 1;
          document.splice(position, 0, next[index]);
        }
        position += 1;
      }
    } else {
      let position = document.indexOf(mapped[newStart]);
      for (let index = newStart - 1; index >= top; index -= 1) {
        const existing = document[position - 1];
        if (existing && !fixed.has(existing) && sameRow(existing, next[index])) {
          mapped[index] = existing;
          position -= 1;
        } else {
          mapped[index] = next[index];
          firstInserted = Math.min(firstInserted, position);
          addedChars += next[index].text.length + 1;
          document.splice(position, 0, next[index]);
        }
      }
    }
    if (document.length > 10000 || this.capturedChars + addedChars > 1024 * 1024) {
      return "limit";
    }
    this.rows = document;
    this.frame = mapped;
    this.scrollMotion = { top, bottom, lines: oldStart - newStart };
    this.scrollRegion = { top, bottom };
    this.capturedChars += addedChars;
    for (let index = firstInserted; index < document.length; index++) {
      this.positions.set(document[index], index);
    }
    this.cachedText = undefined;
    this.cachedHasSelection = undefined;
    return "moved";
  }

  private range() {
    const anchor = { row: this.positions.get(this.anchor.row)!, col: this.anchor.col };
    const end = { row: this.positions.get(this.end.row)!, col: this.end.col };
    return anchor.row < end.row || (anchor.row === end.row && anchor.col <= end.col)
      ? { start: anchor, end } : { start: end, end: anchor };
  }

  getText(): string {
    if (this.cachedText !== undefined) return this.cachedText;
    const { start, end } = this.range();
    const selected = this.rows.slice(start.row, end.row + 1);
    const left = Math.min(this.anchor.col, this.end.col);
    const right = Math.max(this.anchor.col, this.end.col);
    this.cachedText = selected.map((row, index) => {
      const first = this.columnMode ? left : index === 0 ? start.col : 0;
      const last = this.columnMode ? right : index === selected.length - 1 ? end.col : row.offsets.length - 1;
      const text = row.text.slice(row.offsets[first] ?? row.text.length, row.offsets[last] ?? row.text.length);
      return `${index > 0 && (this.columnMode || !row.wrapped) ? "\n" : ""}${text}`;
    }).join("");
    return this.cachedText;
  }

  /** Visible part of the frozen selection, using xterm's public select API. */
  getVisibleRange(): { start: SelectionPoint; end: SelectionPoint } | null {
    const { start, end } = this.range();
    let first = -1;
    let last = -1;
    this.frame.forEach((row, index) => {
      const position = this.positions.get(row)!;
      if (position >= start.row && position <= end.row) {
        if (first < 0) first = index;
        last = index;
      }
    });
    if (first < 0) return null;
    if (this.columnMode) {
      return {
        start: { row: first, col: Math.min(this.anchor.col, this.end.col) },
        end: { row: last, col: Math.max(this.anchor.col, this.end.col) },
      };
    }
    const startCol = this.positions.get(this.frame[first]) === start.row ? start.col : 0;
    const endCol = this.positions.get(this.frame[last]) === end.row ? end.col : this.frame[last].offsets.length - 1;
    return { start: { row: first, col: startCol }, end: { row: last, col: endCol } };
  }
}
