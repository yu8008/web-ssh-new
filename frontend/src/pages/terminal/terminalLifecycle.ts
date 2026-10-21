import type { IDisposable, Terminal } from "xterm";

type TerminalWithViewport = Terminal & {
  _core?: {
    viewport?: {
      syncScrollArea(immediate?: boolean): void;
      _innerRefresh(): void;
      _refreshAnimationFrame: number | null;
    };
  };
};

export function disposeTerminal(term: Terminal, rendering?: IDisposable | null): void {
  // xterm 5.3 leaves viewport refresh callbacks queued after disposal. Its
  // public API cannot cancel them, so stop this version's pending frame and
  // prevent delayed reset/initialization callbacks from scheduling another.
  const viewport = (term as TerminalWithViewport)._core?.viewport;
  if (viewport) {
    viewport.syncScrollArea = () => {};
    // Immediate refreshes can clear the frame handle before cancelling it.
    viewport._innerRefresh = () => {};
    if (viewport._refreshAnimationFrame !== null) {
      term.element?.ownerDocument.defaultView?.cancelAnimationFrame(viewport._refreshAnimationFrame);
      viewport._refreshAnimationFrame = null;
    }
  }
  // Renderer addons restore the DOM renderer when released, so xterm's
  // render service must still be alive at this point.
  rendering?.dispose();
  term.dispose();
}
