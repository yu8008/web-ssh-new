/** Shared pointer policy for local scrollback and remote TUIs. Start inside
 * the last two rows, so a browser edge doesn't limit the attainable speed. */
export function terminalDragScroll(y: number, top: number, bottom: number, rows: number, edgeLimit = 48) {
  if (bottom <= top || rows <= 0 || !Number.isFinite(y)) return { direction: 0, speed: 0 };
  const rowHeight = (bottom - top) / rows;
  const edge = Math.min((bottom - top) / 3, edgeLimit, Math.max(24, rowHeight * 2));
  const direction = y < top + edge ? -1 : y > bottom - edge ? 1 : 0;
  const depth = direction < 0 ? top + edge - y : direction > 0 ? y - bottom + edge : 0;
  return { direction, speed: direction ? Math.min(240, 32 + depth / rowHeight * 64) : 0 };
}
