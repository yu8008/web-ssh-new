import type { Terminal } from "@xterm/xterm";

const reports = new WeakSet<WheelEvent>();
const GESTURE_IDLE_MS = 120;
const REPORTS_PER_FRAME = 8;
const MAX_PENDING_REPORTS = 256;
const WHEEL_SCROLL_SCALE = 0.85;

export function isLocalTerminalHistory(term: Terminal): boolean {
  const buffer = term.buffer.active;
  return buffer.type === "normal" && buffer.baseY > 0 && buffer.viewportY < buffer.baseY;
}

export const isTerminalWheelReport = (event: WheelEvent) => reports.has(event);

/** Let xterm encode coordinates, modifiers and the negotiated mouse protocol.
 * Mouse reports must not invoke its keyboard-only scroll-to-bottom policy. */
export function dispatchTerminalWheel(term: Terminal, screen: HTMLElement, init: WheelEventInit) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaMode: 1, ...init });
  reports.add(event);
  const followInput = term.options.scrollOnUserInput;
  const suppressFollow = followInput && isLocalTerminalHistory(term);
  // Changing an xterm option schedules a full refresh. The live viewport is
  // already at the bottom, so avoid two needless refreshes per mouse report.
  if (suppressFollow) term.options.scrollOnUserInput = false;
  try { screen.dispatchEvent(event); }
  finally { if (suppressFollow) term.options.scrollOnUserInput = followInput; }
}

/** Keep a gesture on one route. Local history uses public buffer coordinates;
 * application scrolling retains fractional input and emits bounded reports. */
export function attachTerminalWheel(
  term: Terminal, host: HTMLElement, isEnhanced: () => boolean, send: (data: string) => void,
  flushInput: () => void = () => {},
) {
  const view = host.ownerDocument.defaultView!;
  const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
  let route: "local" | "mouse" | "page" | undefined;
  let lastWheel = -Infinity;
  let target = 0;
  let rowHeight = 1;
  let remainder = 0;
  let pending = 0;
  let frame: number | undefined;
  let latest: WheelEvent;
  let disposed = false;
  let mouseMode = term.modes.mouseTrackingMode;
  let bufferType = term.buffer.active.type;

  const cancelPending = () => {
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    pending = remainder = 0;
  };
  const flush = () => {
    frame = undefined;
    if (disposed || route !== "mouse" || mouseMode !== term.modes.mouseTrackingMode || bufferType !== term.buffer.active.type) {
      pending = remainder = 0;
      route = undefined;
      return;
    }
    const count = Math.min(REPORTS_PER_FRAME, Math.abs(pending));
    const direction = Math.sign(pending);
    pending -= direction * count;
    for (let report = 0; report < count; report++) {
      dispatchTerminalWheel(term, screen, {
        deltaY: direction, clientX: latest.clientX, clientY: latest.clientY,
        ctrlKey: latest.ctrlKey, altKey: latest.altKey, metaKey: latest.metaKey,
      });
    }
    flushInput();
    if (pending) frame = view.requestAnimationFrame(flush);
  };
  const onWheel = (event: WheelEvent) => {
    if (reports.has(event) || event.defaultPrevented || !Number.isFinite(event.deltaY) || !event.deltaY || event.shiftKey) return;
    const now = view.performance.now();
    const buffer = term.buffer.active;
    if (now - lastWheel > GESTURE_IDLE_MS || !route || mouseMode !== term.modes.mouseTrackingMode || bufferType !== buffer.type) {
      cancelPending();
      mouseMode = term.modes.mouseTrackingMode;
      bufferType = buffer.type;
      rowHeight = Math.max(1, screen.getBoundingClientRect().height / term.rows);
      target = buffer.viewportY;
      const local = buffer.type === "normal" && buffer.baseY > 0;
      const mouse = term.modes.mouseTrackingMode !== "none" && term.modes.mouseTrackingMode !== "x10";
      if (mouse && isLocalTerminalHistory(term)) route = "local";
      else if (mouse) route = "mouse";
      else if (!local || (isEnhanced() && (event.deltaY < 0 ? target === 0 : target === buffer.baseY))) route = "page";
      else route = "local";
    }
    lastWheel = now;
    event.preventDefault();
    event.stopImmediatePropagation();
    let lines = event.deltaY * (event.deltaMode === 0 ? 1 / rowHeight : event.deltaMode === 2 ? term.rows : 1);
    lines *= WHEEL_SCROLL_SCALE * (term.options.scrollSensitivity ?? 1) * (event.altKey ? term.options.fastScrollSensitivity ?? 5 : 1);
    if (route === "local") {
      target = Math.max(0, Math.min(buffer.baseY, target + lines));
      term.scrollToLine(Math.round(target));
    } else if (route === "page") {
      // A page key has application-defined semantics, so don't multiply it by
      // pixels. Preserve the existing non-mouse fallback at history boundaries.
      send(lines < 0 ? "\x1b[5~" : "\x1b[6~");
    } else {
      latest = event;
      if (Math.sign(lines) !== Math.sign(pending || remainder || lines)) cancelPending();
      remainder += lines;
      const whole = Math.trunc(remainder + Math.sign(remainder) * 1e-9);
      remainder -= whole;
      pending = Math.max(-MAX_PENDING_REPORTS, Math.min(MAX_PENDING_REPORTS, pending + whole));
      if (pending && frame === undefined) {
        flush();
        // Even an empty first batch owns the rest of this frame. New physical
        // events join it instead of scheduling unlimited synchronous reports.
        if (frame === undefined) frame = view.requestAnimationFrame(flush);
      }
    }
  };
  const reset = () => { route = undefined; cancelPending(); };
  const resized = term.onResize(reset);
  host.addEventListener("wheel", onWheel, { capture: true, passive: false });
  host.addEventListener("keydown", reset, true);
  host.addEventListener("mousedown", reset, true);
  view.addEventListener("blur", reset);
  return { dispose() {
    disposed = true;
    reset();
    host.removeEventListener("wheel", onWheel, true);
    host.removeEventListener("keydown", reset, true);
    host.removeEventListener("mousedown", reset, true);
    view.removeEventListener("blur", reset);
    resized.dispose();
  } };
}
