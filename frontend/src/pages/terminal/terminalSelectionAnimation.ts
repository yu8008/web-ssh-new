import type { IBufferCell, Terminal } from "xterm";
import type { SelectionRange, SelectionRow, SelectionScrollMotion } from "./selectionTranscript";
import { xtermPaletteColor } from "./terminalUtils";

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
const ANSI_DEFAULTS = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf", "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"];
type ForegroundRun = { element: HTMLSpanElement; start: number; end: number; text: string; columnsPerChar: number; dim: boolean };
type PaintedRow = { element: HTMLDivElement; text: string; nodes: number; highlight: HTMLDivElement; selected: string; foreground: ForegroundRun[] };

/** xterm paints text at integer rows even when its scrollbar moves in pixels.
 * Interpolate a bounded window of verified text during selection. Reuse rows,
 * retain cell coordinates/styles and leave copying with the original buffer.
 * No viewport bitmap copies or React renders are needed for animation. */
export function createSelectionAnimation(term: Terminal, screen: HTMLElement, getRange?: () => SelectionRange | null) {
  const doc = screen.ownerDocument;
  const view = doc.defaultView!;
  let enabled = false;
  let ending = false;
  let waiting = false;
  let frame: number | undefined;
  let endTimer: number | undefined;
  let cover: HTMLDivElement | null = null;
  let layer: HTMLDivElement | null = null;
  let content: HTMLDivElement | null = null;
  let region: SelectionScrollMotion | null = null;
  let target = 0;
  let position = 0;
  let lastAdvance = 0;
  let responseWindow = 0;
  let rate = 0;
  let velocity = 0;
  let stepLines = 0;
  let width = 0;
  let rowHeight = 0;
  let cellWidth = 0;
  let nodeCount = 0;
  let base = 0;
  let opaqueSelection = false;
  let selectionFill = "";
  let selectionOpacity = "";
  const rows = new Map<number, PaintedRow>();
  const pinnedRows = new Map<number, PaintedRow>();
  const spacing = new Map<string, number>();
  let measure: CanvasRenderingContext2D | null = null;

  const cancel = () => {
    enabled = ending = waiting = false;
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    view.clearTimeout(endTimer);
    cover?.remove();
    cover = layer = content = null;
    region = null;
    rows.clear();
    pinnedRows.clear();
    spacing.clear();
    measure = null;
    nodeCount = 0;
    position = target = lastAdvance = responseWindow = rate = velocity = stepLines = 0;
    base = 0;
  };
  const palette = (index: number) => index < 16
    ? term.options.theme?.[ANSI_NAMES[index]] ?? ANSI_DEFAULTS[index]
    : term.options.theme?.extendedAnsi?.[index - 16] ?? xtermPaletteColor(index);
  const colors = (cell: IBufferCell) => {
    let fg = cell.isFgRGB() ? `#${cell.getFgColor().toString(16).padStart(6, "0")}`
      : cell.isFgPalette() ? palette(cell.getFgColor() + (cell.isBold() && term.options.drawBoldTextInBrightColors && cell.getFgColor() < 8 ? 8 : 0))
        : term.options.theme?.foreground ?? "#ffffff";
    let bg = cell.isBgRGB() ? `#${cell.getBgColor().toString(16).padStart(6, "0")}`
      : cell.isBgPalette() ? palette(cell.getBgColor()) : term.options.theme?.background ?? "#000000";
    if (cell.isInverse()) [fg, bg] = [bg, fg];
    return { fg, bg };
  };
  const paintRow = (screenRow: number, index: number, text: string): PaintedRow => {
    const element = doc.createElement("div");
    element.className = "wsg-selection-row";
    Object.assign(element.style, { position: "absolute", left: "0", top: `${(index - base) * rowHeight}px`, width: `${width}px`, height: `${rowHeight}px`, contain: "layout paint" });
    const line = term.buffer.active.getLine(term.buffer.active.viewportY + screenRow);
    const cell = term.buffer.active.getNullCell();
    const foreground: ForegroundRun[] = [];
    let run: { element: HTMLSpanElement; textElement: HTMLSpanElement; text: string; start: number; end: number; key: string; columnsPerChar: number } | null = null;
    let background: { element: HTMLSpanElement; start: number; end: number; color: string } | null = null;
    const flushBackground = () => {
      if (background) background.element.style.width = `${(background.end - background.start) * cellWidth}px`;
    };
    const flushRun = () => {
      if (!run) return;
      run.textElement.textContent = run.text;
      run.element.style.width = `${(run.end - run.start) * cellWidth}px`;
      if (run.textElement !== run.element || term.options.theme?.selectionForeground) {
        foreground.push({ element: run.textElement, text: run.text, start: run.start, end: run.end, columnsPerChar: run.columnsPerChar, dim: run.textElement !== run.element });
      }
    };
    let nodes = 1;
    const paintBackground = (color: string, col: number, columns: number) => {
      if (background && background.color === color && background.end === col) background.end = col + columns;
      else {
        flushBackground();
        background = null;
        if (color !== (term.options.theme?.background ?? "#000000")) {
          const fill = doc.createElement("span");
          fill.className = "wsg-cell-background";
          Object.assign(fill.style, { position: "absolute", left: `${col * cellWidth}px`, top: "0", height: `${rowHeight}px`, backgroundColor: color });
          element.appendChild(fill);
          nodes++;
          background = { element: fill, start: col, end: col + columns, color };
        }
      }
    };
    for (let col = 0; col < term.cols; col++) {
      if (!line?.getCell(col, cell) || cell.getWidth() === 0) continue;
      const chars = cell.isInvisible() ? " " : cell.getChars() || " ";
      const { fg, bg } = colors(cell);
      paintBackground(bg, col, cell.getWidth());
      const weight = String(cell.isBold() ? term.options.fontWeightBold ?? "bold" : term.options.fontWeight ?? "normal");
      const italic = cell.isItalic() ? "italic" : "normal";
      const decoration = [cell.isUnderline() ? "underline" : "", cell.isStrikethrough() ? "line-through" : "", cell.isOverline() ? "overline" : ""].filter(Boolean).join(" ");
      const ascii = cell.getWidth() === 1 && /^[\x20-\x7e]$/.test(chars);
      // Fixed-width BMP CJK glyphs can share a run too. One node per Chinese
      // character exhausted the paint budget during an otherwise ordinary drag.
      // Keep emoji/combined glyphs in individual cells and retain exact spacing.
      const columnsPerChar = ascii ? 1 : cell.getWidth() === 2 && /^[\u2e80-\u9fff\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60\uffe0-\uffe6]$/.test(chars) ? 2 : 0;
      let letterSpacing = "";
      if (columnsPerChar) {
        const font = `${italic} ${weight} ${term.options.fontSize ?? 15}px ${term.options.fontFamily ?? "monospace"}`;
        const key = ascii ? font : `${font}|${chars}`;
        if (!spacing.has(key)) { measure!.font = font; spacing.set(key, columnsPerChar * cellWidth - measure!.measureText(ascii ? "M" : chars).width); }
        letterSpacing = `${spacing.get(key)}px`;
      }
      const key = `${fg}|${bg}|${weight}|${italic}|${cell.isDim()}|${decoration}|${columnsPerChar}|${letterSpacing}`;
      if (columnsPerChar && run && run.end === col && run.key === key) {
        run.text += chars;
        run.end += columnsPerChar;
        continue;
      }
      flushRun();
      const span = doc.createElement("span");
      span.className = "wsg-cell-text";
      Object.assign(span.style, {
        position: "absolute", left: `${col * cellWidth}px`, top: "0", width: `${cell.getWidth() * cellWidth}px`, height: `${rowHeight}px`,
        color: fg, zIndex: "1", fontWeight: weight, fontStyle: italic, textDecoration: decoration,
        whiteSpace: "pre", lineHeight: `${rowHeight}px`,
      });
      if (columnsPerChar) span.style.letterSpacing = letterSpacing;
      if (cell.isDim()) {
        const glyph = doc.createElement("span");
        glyph.style.opacity = "0.5";
        glyph.textContent = chars;
        span.appendChild(glyph);
        nodes++;
        run = columnsPerChar ? { element: span, textElement: glyph, text: chars, start: col, end: col + columnsPerChar, key, columnsPerChar } : null;
      } else if (columnsPerChar) {
        run = { element: span, textElement: span, text: chars, start: col, end: col + columnsPerChar, key, columnsPerChar };
      } else {
        span.textContent = chars;
        run = null;
      }
      if (!columnsPerChar && (cell.isDim() || term.options.theme?.selectionForeground)) {
        foreground.push({ element: cell.isDim() ? span.firstElementChild as HTMLSpanElement : span, text: chars, start: col, end: col + cell.getWidth(), columnsPerChar: 0, dim: !!cell.isDim() });
      }
      element.appendChild(span);
      nodes++;
      if (nodeCount + nodes > 4096) throw new Error("Selection paint budget exceeded");
    }
    flushRun();
    flushBackground();
    const highlight = doc.createElement("div");
    Object.assign(highlight.style, { position: "absolute", top: "0", height: `${rowHeight}px`, pointerEvents: "none", display: "none", zIndex: opaqueSelection ? "0" : "2" });
    highlight.style.backgroundColor = selectionFill;
    highlight.style.opacity = selectionOpacity;
    element.appendChild(highlight);
    return { element, highlight, text, nodes: nodes + 1, selected: "", foreground };
  };
  const updateSelection = () => {
    if (!enabled || !content) return;
    const native = term.getSelectionPosition();
    const selected = getRange?.() ?? (native ? {
      start: { row: native.start.y - term.buffer.active.viewportY, col: native.start.x },
      end: { row: native.end.y - term.buffer.active.viewportY, col: native.end.x },
    } : null);
    const start = selected ? target + selected.start.row : Infinity;
    const end = selected ? target + selected.end.row : -Infinity;
    const column = screen.querySelector<HTMLElement>(".wsg-column-selection");
    const columnRect = column?.getBoundingClientRect();
    const screenRect = columnRect ? screen.getBoundingClientRect() : null;
    const updateRow = (index: number, row: PaintedRow, pinned = false) => {
      const firstRow = pinned ? native ? native.start.y - term.buffer.active.viewportY : Infinity : start;
      const lastRow = pinned ? native ? native.end.y - term.buffer.active.viewportY : -Infinity : end;
      let first = index === firstRow ? pinned ? native!.start.x : selected!.start.col : 0;
      let last = index === lastRow ? pinned ? native!.end.x : selected!.end.col : term.cols;
      let visible = index >= firstRow && index <= lastRow;
      if (columnRect && screenRect) {
        const screenRow = pinned ? index : index - target;
        visible = screenRow >= Math.round((columnRect.top - screenRect.top) / rowHeight) && screenRow < Math.round((columnRect.bottom - screenRect.top) / rowHeight);
        first = (columnRect.left - screenRect.left) / cellWidth;
        last = (columnRect.right - screenRect.left) / cellWidth;
      }
      const key = visible ? `${first}:${last}` : "";
      if (key === row.selected) return;
      row.selected = key;
      row.highlight.style.display = visible ? "block" : "none";
      row.highlight.style.left = `${first * cellWidth}px`;
      row.highlight.style.width = `${Math.max(0, last - first) * cellWidth}px`;
      for (const run of row.foreground) {
        const left = visible ? Math.max(0, Math.min(run.end - run.start, first - run.start)) : 0;
        const right = visible ? Math.max(left, Math.min(run.end - run.start, last - run.start)) : 0;
        const selected = right > left;
        // Native selected glyphs lose ANSI dim. Preserve partial text runs,
        // so selecting half a line doesn't brighten its unselected prefix.
        run.element.style.opacity = run.dim && !selected ? "0.5" : "1";
        run.element.style.color = selected ? term.options.theme?.selectionForeground ?? "" : "";
        if (selected && run.columnsPerChar && (left > 0 || right < run.end - run.start)) {
          run.element.style.color = "";
          const first = Math.floor(left / run.columnsPerChar);
          const last = Math.ceil(right / run.columnsPerChar);
          const parts = [run.text.slice(0, first), run.text.slice(first, last), run.text.slice(last)].map((text, index) => {
            const part = doc.createElement("span");
            part.textContent = text;
            if (index !== 1 && run.dim) part.style.opacity = "0.5";
            if (index === 1) part.style.color = term.options.theme?.selectionForeground ?? "";
            return part;
          });
          run.element.replaceChildren(...parts);
        } else if (run.element.textContent !== run.text || run.element.childElementCount) run.element.textContent = run.text;
      }
    };
    rows.forEach((row, index) => updateRow(index, row));
    pinnedRows.forEach((row, index) => updateRow(index, row, true));
  };
  const prune = () => {
    if (!region) return;
    const first = Math.floor(Math.min(position, target)) + region.top - 2;
    const last = Math.ceil(Math.max(position, target)) + region.bottom + 2;
    for (const [index, row] of rows) if (index < first || index >= last) {
      nodeCount -= row.nodes;
      row.element.remove();
      rows.delete(index);
    }
    // Rebase CSS coordinates too: leaving row tops at ever-growing document
    // offsets makes the compositor allocate increasingly tall paint surfaces.
    if (Math.abs(base - first) >= term.rows) {
      base = first;
      for (const [index, row] of rows) row.element.style.top = `${(index - base) * rowHeight}px`;
    }
    if (content) content.style.transform = `translate3d(0, calc(${base * rowHeight}px + var(--selection-scroll-position, 0px)), 0)`;
  };
  const advance = (now: number) => {
    if (!content) return;
    const elapsed = Math.max(0, Math.min(64, now - lastAdvance));
    lastAdvance = now;
    const gap = target - position;
    // Keep a small reserve of verified rows and consume it at a filtered rate.
    // Restarting a fixed-duration tween for each SSH response produces a stop
    // between packets and an abrupt speed change at every repaint. This clock
    // retains its velocity across packets and slows gently if the reserve runs
    // low. It never advances past text actually received from the terminal.
    const reserve = Math.min((region ? region.bottom - region.top : term.rows) / 3, stepLines * 0.75);
    const cruise = rate * Math.max(0.3, 1 + (Math.abs(gap) - reserve) / Math.max(1, stepLines) * 0.2);
    const desired = Math.sign(gap) * Math.min(cruise, Math.abs(gap) / (ending ? 40 : waiting ? Math.max(32, responseWindow * 0.35) : 50));
    if (velocity * gap < 0) velocity = 0;
    velocity += (desired - velocity) * (1 - Math.exp(-elapsed / Math.max(24, Math.min(100, responseWindow * 0.3))));
    position += Math.sign(gap) * Math.min(Math.abs(gap), Math.abs(velocity * elapsed));
    if (Math.abs(target - position) < 0.001) { position = target; velocity = 0; }
    content.style.setProperty("--selection-scroll-position", `${-position * rowHeight}px`);
    content.style.transform = `translate3d(0, calc(${base * rowHeight}px + var(--selection-scroll-position)), 0)`;
  };
  const animate = (now: number) => {
    frame = undefined;
    if (!enabled) return;
    advance(now);
    if (position !== target) frame = view.requestAnimationFrame(animate);
    else { prune(); if (ending && !waiting) cancel(); }
  };
  const show = (motion: SelectionScrollMotion) => {
    if (!layer || !content) return;
    region = motion;
    layer.style.top = `${motion.top * rowHeight}px`;
    layer.style.height = `${(motion.bottom - motion.top) * rowHeight}px`;
    content.style.top = `${-motion.top * rowHeight}px`;
    if (!cover!.isConnected) screen.appendChild(cover!);
  };
  const rendered = term.onRender(() => {
    if (enabled && opaqueSelection !== (term.element?.dataset.terminalRenderer === "webgl")) cancel();
    else updateSelection();
  });

  return {
    start() {
      cancel();
      if (view.matchMedia("(prefers-reduced-motion: reduce)").matches || !screen.querySelector(":scope > canvas")) return;
      const bounds = screen.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      enabled = true;
      opaqueSelection = term.element?.dataset.terminalRenderer === "webgl";
      width = bounds.width;
      rowHeight = bounds.height / term.rows;
      cellWidth = width / term.cols;
      const measurementCanvas = doc.createElement("canvas");
      measurementCanvas.width = measurementCanvas.height = 1;
      measure = measurementCanvas.getContext("2d");
      if (!measure) return cancel();
      selectionFill = term.options.theme?.selectionBackground ?? "rgba(255,255,255,0.3)";
      measure.fillStyle = selectionFill;
      measure.fillRect(0, 0, 1, 1);
      selectionOpacity = measure.getImageData(0, 0, 1, 1).data[3] === 255 ? "0.3" : "";
      if (opaqueSelection) {
        // WebGL replaces selected cell backgrounds with a color blended against
        // the terminal background. Canvas instead overlays a translucent fill.
        measure.clearRect(0, 0, 1, 1);
        measure.fillStyle = term.options.theme?.background ?? "#000000";
        measure.fillRect(0, 0, 1, 1);
        measure.fillStyle = selectionFill;
        measure.fillRect(0, 0, 1, 1);
        const [r, g, b] = measure.getImageData(0, 0, 1, 1).data;
        selectionFill = `rgb(${r}, ${g}, ${b})`;
        selectionOpacity = "";
      }
      layer = doc.createElement("div");
      layer.className = "wsg-selection-scroll";
      layer.setAttribute("aria-hidden", "true");
      Object.assign(layer.style, { position: "absolute", left: "0", width: `${width}px`, overflow: "hidden", pointerEvents: "none", zIndex: "4", contain: "layout paint", background: term.options.theme?.background ?? "#000000" });
      content = doc.createElement("div");
      content.className = "wsg-selection-content";
      Object.assign(content.style, { position: "absolute", left: "0", width: `${width}px`, height: `${bounds.height}px`, willChange: "transform", pointerEvents: "none", fontFamily: term.options.fontFamily ?? "monospace", fontSize: `${term.options.fontSize ?? 15}px`, fontKerning: "none", fontVariantLigatures: "none" });
      layer.appendChild(content);
      // Own the complete frame during a drag. Exposing the native footer while
      // the body is still interpolating shows two different moments at once.
      cover = doc.createElement("div");
      cover.className = "wsg-selection-frame";
      cover.setAttribute("aria-hidden", "true");
      Object.assign(cover.style, {
        position: "absolute", inset: "0", overflow: "hidden", pointerEvents: "none", zIndex: "4",
        background: term.options.theme?.background ?? "#000000",
        fontFamily: term.options.fontFamily ?? "monospace", fontSize: `${term.options.fontSize ?? 15}px`,
        fontKerning: "none", fontVariantLigatures: "none",
      });
      cover.appendChild(layer);
      try {
        for (let index = 0; index < term.rows; index++) {
          const text = term.buffer.active.getLine(term.buffer.active.viewportY + index)?.translateToString(true).trimEnd() ?? "";
          const row = paintRow(index, index, text);
          rows.set(index, row);
          nodeCount += row.nodes;
          content.appendChild(row.element);
        }
      } catch { cancel(); }
    },
    prepare(pending = true) { if (enabled) waiting = pending; },
    invalidate() { if (enabled && waiting && !region) show({ top: 0, bottom: term.rows, lines: 0 }); },
    move(motion: SelectionScrollMotion, elapsed: number, verifiedRows?: SelectionRow[]) {
      if (!enabled || !content) return;
      try {
        const now = view.performance.now();
        if (lastAdvance) advance(now);
        lastAdvance = now;
        const oldTarget = target;
        if (region?.top !== motion.top || region?.bottom !== motion.bottom) {
          for (const [index, row] of pinnedRows) if (index >= motion.top && index < motion.bottom) {
            pinnedRows.delete(index);
            row.element.classList.remove("wsg-selection-pinned");
            rows.set(oldTarget + index, row);
            row.element.style.top = `${(oldTarget + index - base) * rowHeight}px`;
            content.appendChild(row.element);
          }
          for (const [index, row] of rows) if (index < oldTarget + motion.top || index >= oldTarget + motion.bottom) {
            rows.delete(index);
            const screenRow = index - oldTarget;
            if (screenRow >= 0 && screenRow < term.rows && !pinnedRows.has(screenRow)) {
              pinnedRows.set(screenRow, row);
              row.element.classList.add("wsg-selection-pinned");
              row.element.style.top = `${screenRow * rowHeight}px`;
              cover!.appendChild(row.element);
            } else { nodeCount -= row.nodes; row.element.remove(); }
          }
        }
        target += motion.lines;
        if (Math.abs(target - position) >= 3 * (motion.bottom - motion.top)) position = target;
        show(motion);
        prune();
        const buffer = term.buffer.active;
        const first = verifiedRows ? motion.top : Math.max(-buffer.viewportY, Math.floor(Math.min(position, target) - target) + motion.top);
        const last = verifiedRows ? motion.bottom : Math.min(buffer.length - buffer.viewportY, Math.ceil(Math.max(position, target) - target) + motion.bottom);
        for (let screenRow = first; screenRow < last; screenRow++) {
          const index = target + screenRow;
          const text = verifiedRows?.[screenRow]?.text ?? buffer.getLine(buffer.viewportY + screenRow)?.translateToString(true).trimEnd() ?? "";
          const existing = rows.get(index);
          if (existing?.text === text) continue;
          if (existing) { nodeCount -= existing.nodes; existing.element.remove(); }
          const row = paintRow(screenRow, index, text);
          rows.set(index, row);
          nodeCount += row.nodes;
          content.appendChild(row.element);
        }
        waiting = false;
        updateSelection();
        const interval = Math.max(16, Math.min(2000, elapsed));
        const nextRate = Math.abs(motion.lines) / interval;
        responseWindow = responseWindow ? responseWindow * 0.8 + interval * 0.2 : interval;
        rate = rate ? rate * 0.8 + nextRate * 0.2 : nextRate;
        stepLines = Math.abs(motion.lines);
        if (frame === undefined) frame = view.requestAnimationFrame(animate);
      } catch { cancel(); }
    },
    updateSelection,
    finish() {
      if (!enabled) return;
      ending = true;
      if (position === target && !waiting) return cancel();
      endTimer = view.setTimeout(cancel, 1500);
    },
    cancel,
    dispose() { cancel(); rendered.dispose(); },
  };
}
