import type { Terminal } from "@xterm/xterm";
import type { SelectionRange } from "./selectionTranscript";

/** A TUI redraw replaces buffer rows, so its selection cannot be owned by
 * xterm's clear-on-input selection model. Paint only three background rectangles;
 * text, parsing and the terminal renderer remain owned by xterm. */
export function createTerminalSelectionHighlight(term: Terminal, screen: HTMLElement) {
  const layer = screen.ownerDocument.createElement("div");
  layer.className = "wsg-selection-highlight";
  layer.setAttribute("aria-hidden", "true");
  Object.assign(layer.style, {
    position: "absolute", inset: "0", pointerEvents: "none", zIndex: "3", overflow: "hidden",
  });
  const rectangles = Array.from({ length: 3 }, () => {
    const rectangle = screen.ownerDocument.createElement("div");
    Object.assign(rectangle.style, { position: "absolute", display: "none" });
    layer.appendChild(rectangle);
    return rectangle;
  });
  let signature = "";
  const hide = () => {
    layer.remove();
    signature = "";
  };
  return {
    draw(range: SelectionRange | null, column: boolean) {
      if (!range) { hide(); return; }
      const { start, end } = range;
      const theme = term.options.theme;
      const background = theme?.background ?? "#000000";
      const color = theme?.selectionBackground ?? "#64748b";
      const next = [start.row, start.col, end.row, end.col, column, term.cols, term.rows, background, color].join(":");
      if (next === signature) return;
      signature = next;
      // Lighten dark surfaces and darken light surfaces without covering glyphs
      // with an opaque selection color. Both DOM and WebGL use the same layer.
      const hex = /^#([\da-f]{6})$/i.exec(background)?.[1];
      const light = hex ? [0, 2, 4].reduce((sum, offset, i) =>
        sum + parseInt(hex.slice(offset, offset + 2), 16) * [0.2126, 0.7152, 0.0722][i], 0) > 128 : false;
      layer.style.mixBlendMode = light ? "darken" : "lighten";
      const regions = column || start.row === end.row
        ? [{ row: start.row, col: start.col, width: end.col - start.col, rows: end.row - start.row + 1 }]
        : [
          { row: start.row, col: start.col, width: term.cols - start.col, rows: 1 },
          { row: start.row + 1, col: 0, width: term.cols, rows: end.row - start.row - 1 },
          { row: end.row, col: 0, width: end.col, rows: 1 },
        ];
      rectangles.forEach((rectangle, index) => {
        const region = regions[index];
        if (!region || region.width <= 0 || region.rows <= 0) { rectangle.style.display = "none"; return; }
        Object.assign(rectangle.style, {
          display: "block", background: color,
          left: `${region.col / term.cols * 100}%`, top: `${region.row / term.rows * 100}%`,
          width: `${region.width / term.cols * 100}%`, height: `${region.rows / term.rows * 100}%`,
        });
      });
      rectangles[0].classList.toggle("wsg-column-selection", column);
      if (!layer.isConnected) screen.appendChild(layer);
    },
    hide,
    dispose: hide,
  };
}
