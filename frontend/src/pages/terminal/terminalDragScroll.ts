/** Shared pointer policy for local scrollback and remote TUIs. Start inside
 * the last two rows, so a browser edge doesn't limit the attainable speed. */
export function terminalDragScroll(y: number, top: number, bottom: number, rows: number, edgeLimit = 48, heldMs = 0) {
  if (bottom <= top || rows <= 0 || !Number.isFinite(y)) return { direction: 0, speed: 0, fast: false };
  const rowHeight = (bottom - top) / rows;
  const edge = Math.min((bottom - top) / 3, edgeLimit, Math.max(24, rowHeight * 2));
  const direction = y < top + edge ? -1 : y > bottom - edge ? 1 : 0;
  const depth = direction < 0 ? top + edge - y : direction > 0 ? y - bottom + edge : 0;
  const progress = Math.min(1, depth / edge);
  const fast = !!direction && progress >= 0.75;
  // Reach full speed at the text boundary, even when the browser leaves no
  // space below it. A sustained hold accelerates only the outermost half-row.
  const boost = fast ? Math.min(1, Math.max(0, heldMs - 400) / 400) : 0;
  const speed = direction ? 32 + 208 * progress ** 1.5 + 120 * boost * (progress - 0.75) / 0.25 : 0;
  return { direction, speed, fast };
}
