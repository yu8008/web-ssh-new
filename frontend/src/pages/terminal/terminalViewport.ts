import type { IMarker, Terminal } from "@xterm/xterm";

type ViewportSnapshot = { revision: number; follow: boolean; marker?: IMarker };

/** Anchor the top row with an xterm marker so history eviction cannot move the
 * reader to different text. A gesture that starts during parsing always wins. */
export function attachTerminalViewport(term: Terminal, host: HTMLElement) {
  const view = host.ownerDocument.defaultView!;
  let revision = 0;
  let dragging = false;
  let scrolling = false;
  let timer: number | undefined;
  const markers = new Set<IMarker>();
  const interact = () => {
    revision += 1;
    scrolling = true;
    view.clearTimeout(timer);
    timer = view.setTimeout(() => { scrolling = false; }, (term.options.smoothScrollDuration ?? 0) + 32);
  };
  const down = (event: MouseEvent) => { if (event.button === 0) { dragging = true; revision += 1; } };
  const up = () => { dragging = false; revision += 1; };
  const key = (event: KeyboardEvent) => {
    if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key)) interact();
  };
  host.addEventListener("wheel", interact, { capture: true, passive: true });
  host.addEventListener("touchmove", interact, { capture: true, passive: true });
  host.addEventListener("mousedown", down, true);
  host.addEventListener("keydown", key, true);
  view.addEventListener("mouseup", up);
  view.addEventListener("blur", up);
  return {
    interact,
    capture(): ViewportSnapshot | undefined {
      const buffer = term.buffer.active;
      if (buffer.type !== "normal" || dragging || scrolling) return;
      const follow = buffer.viewportY >= buffer.baseY;
      const marker = follow ? undefined : term.registerMarker(buffer.viewportY - buffer.baseY - buffer.cursorY);
      if (marker) markers.add(marker);
      return { revision, follow, marker };
    },
    restore(snapshot: unknown) {
      const state = snapshot as ViewportSnapshot | undefined;
      if (!state) return;
      try {
        if (state.revision !== revision || dragging || scrolling || term.buffer.active.type !== "normal") return;
        const line = state.follow ? term.buffer.active.baseY : state.marker && !state.marker.isDisposed ? state.marker.line : 0;
        if (term.buffer.active.viewportY !== line) {
          // An output correction must not start a fresh smooth-scroll animation
          // on every chunk. User wheel gestures keep their configured duration.
          const duration = term.options.smoothScrollDuration;
          term.options.smoothScrollDuration = 0;
          try { term.scrollToLine(line); }
          finally { term.options.smoothScrollDuration = duration; }
        }
      } finally {
        state.marker?.dispose();
        if (state.marker) markers.delete(state.marker);
      }
    },
    dispose() {
      view.clearTimeout(timer);
      markers.forEach((marker) => marker.dispose());
      markers.clear();
      host.removeEventListener("wheel", interact, true);
      host.removeEventListener("touchmove", interact, true);
      host.removeEventListener("mousedown", down, true);
      host.removeEventListener("keydown", key, true);
      view.removeEventListener("mouseup", up);
      view.removeEventListener("blur", up);
    },
  };
}
