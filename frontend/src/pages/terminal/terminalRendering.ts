import type { Terminal } from "xterm";
import { CanvasAddon } from "xterm-addon-canvas";

/** Keep dense, colored TUI repaints out of the DOM layout path. */
export function configureTerminalRendering(term: Terminal): void {
  term.options.smoothScrollDuration = 100;
  const canvas = new CanvasAddon();
  try {
    term.loadAddon(canvas);
  } catch {
    // Restricted browsers can disable canvas. xterm's DOM renderer still works.
    canvas.dispose();
  }
}
