import type { IDisposable, Terminal } from "@xterm/xterm";

export function disposeTerminal(term: Terminal, rendering?: IDisposable | null): void {
  // Renderer addons restore the DOM renderer when released, so xterm's
  // render service must still be alive at this point.
  rendering?.dispose();
  term.dispose();
}
