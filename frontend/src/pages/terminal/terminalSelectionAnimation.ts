import type { IBufferCell, Terminal } from "xterm";
import type { SelectionRow, SelectionScrollMotion } from "./selectionTranscript";
import { xtermPaletteColor } from "./terminalUtils";

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
const ANSI_DEFAULTS = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf", "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"];
type PaintedRow = { element: HTMLDivElement; text: string; nodes: number; highlight: HTMLDivElement; selected: string };

/** xterm paints text at integer rows even when its scrollbar moves in pixels.
 * Interpolate a bounded window of verified text during selection. Reuse rows,
 * retain cell coordinates/styles and leave copying with the original buffer.
 * No viewport bitmap copies or React renders are needed for animation. */
export function createSelectionAnimation(term: Terminal, screen: HTMLElement) {
  const doc = screen.ownerDocument;
  const view = doc.defaultView!;
  let enabled = false;
  let ending = false;
  let waiting = false;
  let frame: number | undefined;
  let endTimer: number | undefined;
  let layer: HTMLDivElement | null = null;
  let content: HTMLDivElement | null = null;
  let region: SelectionScrollMotion | null = null;
  let target = 0;
  let position = 0;
  let origin = 0;
  let started = 0;
  let duration = 0;
  let width = 0;
  let rowHeight = 0;
  let cellWidth = 0;
  let nodeCount = 0;
  let base = 0;
  const rows = new Map<number, PaintedRow>();
  const spacing = new Map<string, number>();
  let measure: CanvasRenderingContext2D | null = null;

  const cancel = () => {
    enabled = ending = waiting = false;
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    view.clearTimeout(endTimer);
    layer?.remove();
    layer = content = null;
    region = null;
    rows.clear();
    spacing.clear();
    measure = null;
    nodeCount = 0;
    position = target = origin = duration = 0;
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
    let run: { element: HTMLSpanElement; textElement: HTMLSpanElement; text: string; start: number; end: number; key: string } | null = null;
    let background: { element: HTMLSpanElement; start: number; end: number; color: string } | null = null;
    const flushBackground = () => {
      if (background) background.element.style.width = `${(background.end - background.start) * cellWidth}px`;
    };
    const flushRun = () => {
      if (!run) return;
      run.textElement.textContent = run.text;
      run.element.style.width = `${(run.end - run.start) * cellWidth}px`;
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
      const key = `${fg}|${bg}|${weight}|${italic}|${cell.isDim()}|${decoration}`;
      const ascii = cell.getWidth() === 1 && /^[\x20-\x7e]$/.test(chars);
      if (ascii && run && run.end === col && run.key === key) {
        run.text += chars;
        run.end++;
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
      if (ascii) {
        const font = `${italic} ${weight} ${term.options.fontSize ?? 15}px ${term.options.fontFamily ?? "monospace"}`;
        if (!spacing.has(font)) { measure!.font = font; spacing.set(font, cellWidth - measure!.measureText("M").width); }
        span.style.letterSpacing = `${spacing.get(font)}px`;
      }
      if (cell.isDim()) {
        const glyph = doc.createElement("span");
        glyph.style.opacity = "0.5";
        glyph.textContent = chars;
        span.appendChild(glyph);
        nodes++;
        run = ascii ? { element: span, textElement: glyph, text: chars, start: col, end: col + 1, key } : null;
      } else if (ascii) {
        run = { element: span, textElement: span, text: chars, start: col, end: col + 1, key };
      } else {
        span.textContent = chars;
        run = null;
      }
      element.appendChild(span);
      nodes++;
      if (nodeCount + nodes > 4096) throw new Error("Selection paint budget exceeded");
    }
    flushRun();
    flushBackground();
    const highlight = doc.createElement("div");
    Object.assign(highlight.style, { position: "absolute", top: "0", height: `${rowHeight}px`, pointerEvents: "none", display: "none", zIndex: "2" });
    const color = term.options.theme?.selectionBackground ?? "rgba(255,255,255,0.3)";
    highlight.style.backgroundColor = color;
    // xterm also applies 30% opacity to opaque selection background colors.
    if (/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color)) highlight.style.opacity = "0.3";
    element.appendChild(highlight);
    return { element, highlight, text, nodes: nodes + 1, selected: "" };
  };
  const updateSelection = () => {
    if (!enabled || !content) return;
    const selected = term.getSelectionPosition();
    const start = selected ? target + selected.start.y - term.buffer.active.viewportY : Infinity;
    const end = selected ? target + selected.end.y - term.buffer.active.viewportY : -Infinity;
    const column = screen.querySelector<HTMLElement>(".wsg-column-selection");
    const columnRect = column?.getBoundingClientRect();
    const screenRect = columnRect ? screen.getBoundingClientRect() : null;
    for (const [index, row] of rows) {
      let first = index === start ? selected!.start.x : 0;
      let last = index === end ? selected!.end.x : term.cols;
      let visible = index >= start && index <= end;
      if (columnRect && screenRect) {
        const screenRow = index - target;
        visible = screenRow >= Math.round((columnRect.top - screenRect.top) / rowHeight) && screenRow < Math.round((columnRect.bottom - screenRect.top) / rowHeight);
        first = (columnRect.left - screenRect.left) / cellWidth;
        last = (columnRect.right - screenRect.left) / cellWidth;
      }
      const key = visible ? `${first}:${last}` : "";
      if (key === row.selected) continue;
      row.selected = key;
      row.highlight.style.display = visible ? "block" : "none";
      row.highlight.style.left = `${first * cellWidth}px`;
      row.highlight.style.width = `${Math.max(0, last - first) * cellWidth}px`;
    }
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
    const fraction = Math.min(1, Math.max(0, (now - started) / duration));
    position = origin + (target - origin) * fraction;
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
    if (!layer.isConnected) screen.appendChild(layer);
  };
  const rendered = term.onRender(updateSelection);

  return {
    start() {
      cancel();
      if (view.matchMedia("(prefers-reduced-motion: reduce)").matches || !screen.querySelector(":scope > canvas")) return;
      const bounds = screen.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      enabled = true;
      width = bounds.width;
      rowHeight = bounds.height / term.rows;
      cellWidth = width / term.cols;
      const measurementCanvas = doc.createElement("canvas");
      measurementCanvas.width = measurementCanvas.height = 1;
      measure = measurementCanvas.getContext("2d");
      if (!measure) return cancel();
      layer = doc.createElement("div");
      layer.className = "wsg-selection-scroll";
      layer.setAttribute("aria-hidden", "true");
      Object.assign(layer.style, { position: "absolute", left: "0", width: `${width}px`, overflow: "hidden", pointerEvents: "none", zIndex: "4", contain: "layout paint", background: term.options.theme?.background ?? "#000000" });
      content = doc.createElement("div");
      content.className = "wsg-selection-content";
      Object.assign(content.style, { position: "absolute", left: "0", width: `${width}px`, height: `${bounds.height}px`, willChange: "transform", pointerEvents: "none", fontFamily: term.options.fontFamily ?? "monospace", fontSize: `${term.options.fontSize ?? 15}px`, fontKerning: "none", fontVariantLigatures: "none" });
      layer.appendChild(content);
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
    prepare() { if (enabled) waiting = true; },
    invalidate() { if (enabled && waiting && !region) show({ top: 0, bottom: term.rows, lines: 0 }); },
    move(motion: SelectionScrollMotion, elapsed: number, verifiedRows?: SelectionRow[]) {
      if (!enabled || !content) return;
      try {
        if (duration) advance(view.performance.now());
        const oldTarget = target;
        if (region?.top !== motion.top || region?.bottom !== motion.bottom) {
          for (const [index, row] of rows) if (index < oldTarget + motion.top || index >= oldTarget + motion.bottom) {
            nodeCount -= row.nodes;
            row.element.remove();
            rows.delete(index);
          }
        }
        target += motion.lines;
        if (Math.abs(target - position) >= motion.bottom - motion.top) position = target;
        show(motion);
        prune();
        for (let screenRow = motion.top; screenRow < motion.bottom; screenRow++) {
          const index = target + screenRow;
          const text = verifiedRows?.[screenRow].text ?? term.buffer.active.getLine(term.buffer.active.viewportY + screenRow)?.translateToString(true).trimEnd() ?? "";
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
        origin = position;
        started = view.performance.now();
        duration = Math.max(32, Math.min(100, elapsed * 1.25));
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
