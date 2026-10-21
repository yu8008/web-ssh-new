import type { Terminal } from "xterm";

/** Local scrolling stays with xterm. Only hand off to tmux at a boundary,
 * including a boundary the ongoing smooth-scroll animation already targets. */
export function attachTerminalWheel(
  term: Terminal, host: HTMLElement, isEnhanced: () => boolean, send: (data: string) => void,
) {
  const view = host.ownerDocument.defaultView!;
  const viewport = host.querySelector<HTMLElement>(".xterm-viewport")!;
  const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
  let target: number | undefined;
  let lastWheel = -Infinity;
  const onWheel = (event: WheelEvent) => {
    if (term.modes.mouseTrackingMode !== "none") {
      target = undefined;
      return;
    }
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0 || event.shiftKey) return;
    const buffer = term.buffer.active;
    const hasLocal = buffer.type === "normal" && buffer.baseY > 0;
    let remote = !hasLocal;
    if (hasLocal && isEnhanced()) {
      const now = view.performance.now();
      const duration = term.options.smoothScrollDuration ?? 0;
      if (target === undefined || now - lastWheel > duration + 32) target = viewport.scrollTop;
      const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      target = Math.min(max, target);
      remote = event.deltaY < 0 ? target <= 0 : target >= max;
      if (!remote) {
        const rowHeight = screen.getBoundingClientRect().height / term.rows;
        let pixels = event.deltaY * (event.deltaMode === 1 ? rowHeight : event.deltaMode === 2 ? rowHeight * term.rows : 1);
        const modifier = term.options.fastScrollModifier;
        const fast = modifier === "alt" ? event.altKey : modifier === "ctrl" ? event.ctrlKey : event.shiftKey;
        pixels *= (term.options.scrollSensitivity ?? 1) * (fast ? term.options.fastScrollSensitivity ?? 5 : 1);
        target = Math.max(0, Math.min(max, target + pixels));
      }
      lastWheel = now;
    } else {
      target = undefined;
    }
    if (remote) {
      event.preventDefault();
      event.stopImmediatePropagation();
      send(event.deltaY < 0 ? "\x1b[5~" : "\x1b[6~");
    }
  };
  const resized = term.onResize(() => { target = undefined; });
  host.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return { dispose() { host.removeEventListener("wheel", onWheel, true); resized.dispose(); } };
}
