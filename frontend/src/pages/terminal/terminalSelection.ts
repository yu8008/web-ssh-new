import type { Terminal } from "xterm";
import { captureSelectionRows, SelectionTranscript, type SelectionPoint, type SelectionRow } from "./selectionTranscript";

type SelectionOptions = {
  onChange: (hasSelection: boolean) => void;
  onFinish: (x: number, y: number) => void;
  onLimit: () => void;
  flushInput?: () => void;
};

/** Native xterm selection handles shell scrollback. Mouse-reporting TUIs need
 * remote wheel input and an immutable transcript instead of buffer coordinates. */
export function attachTerminalSelection(term: Terminal, host: HTMLElement, options: SelectionOptions) {
  const doc = host.ownerDocument;
  const view = doc.defaultView!;
  const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
  let transcript: SelectionTranscript | null = null;
  let pendingDown: MouseEvent | null = null;
  let pendingFrame: SelectionRow[] | null = null;
  let replayingClick = false;
  let customGesture = false;
  let columnMode = false;
  let columnOverlay: HTMLDivElement | null = null;
  let nativeDown = false;
  let active = false;
  let point = { x: 0, y: 0 };
  let frame: number | undefined;
  let needsDraw = false;
  let frameChanged = false;
  let finishAfterDraw = false;
  let notifiedSelection = false;
  let parseTimer: number | undefined;
  let finishTimer: number | undefined;
  let remote: { direction: -1 | 1; started: number } | null = null;
  let stoppedDirection = 0;
  let sendingWheel = false;
  let lastRequestAt = -Infinity;
  let synchronizedRepaint = false;
  let completedRepaint = false;
  let captureStopped = false;
  let disposed = false;
  let capturedFrame: SelectionRow[] = [];
  const captureFrame = () => (capturedFrame = captureSelectionRows(term, capturedFrame));

  const getText = () => transcript?.getText() ?? term.getSelection();
  const hasSelection = () => transcript?.hasSelection() ?? term.hasSelection();
  const notify = () => {
    const selected = hasSelection();
    if (selected === notifiedSelection) return;
    notifiedSelection = selected;
    options.onChange(selected);
  };
  const coords = (x: number, y: number): SelectionPoint => {
    const rect = screen.getBoundingClientRect();
    return {
      row: Math.max(0, Math.min(term.rows - 1, Math.floor((y - rect.top) * term.rows / rect.height))),
      col: Math.max(0, Math.min(term.cols, Math.round((x - rect.left) * term.cols / rect.width))),
    };
  };
  const endpoint = () => {
    const position = coords(point.x, point.y);
    const rect = screen.getBoundingClientRect();
    if (point.y <= rect.top + 12) position.col = 0;
    if (point.y >= rect.bottom - 12) position.col = term.cols;
    return position;
  };
  const draw = () => {
    if (!transcript) return;
    const range = transcript.getVisibleRange();
    if (range && columnMode) {
      term.clearSelection();
      if (!columnOverlay) {
        columnOverlay = doc.createElement("div");
        columnOverlay.className = "wsg-column-selection";
        screen.appendChild(columnOverlay);
      }
      Object.assign(columnOverlay.style, {
        position: "absolute", pointerEvents: "none", zIndex: "3",
        background: term.options.theme?.selectionBackground ?? "rgba(100, 116, 139, 0.5)",
        left: `${range.start.col / term.cols * 100}%`, top: `${range.start.row / term.rows * 100}%`,
        width: `${(range.end.col - range.start.col) / term.cols * 100}%`,
        height: `${(range.end.row - range.start.row + 1) / term.rows * 100}%`,
      });
    } else if (range) {
      columnOverlay?.remove();
      columnOverlay = null;
      const length = (range.end.row - range.start.row) * term.cols + range.end.col - range.start.col;
      term.select(range.start.col, term.buffer.active.viewportY + range.start.row, Math.max(0, length));
    } else {
      term.clearSelection();
    }
    notify();
  };

  const stopTimer = () => {
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    needsDraw = false;
    frameChanged = false;
    finishAfterDraw = false;
  };
  const clear = () => {
    active = false;
    pendingDown = null;
    pendingFrame = null;
    nativeDown = false;
    customGesture = false;
    transcript = null;
    remote = null;
    stoppedDirection = 0;
    captureStopped = false;
    stopTimer();
    view.clearTimeout(parseTimer);
    parseTimer = undefined;
    columnOverlay?.remove();
    columnOverlay = null;
    term.clearSelection();
    notify();
  };

  const requestScroll = (direction: -1 | 1) => {
    if (!active || disposed || captureStopped || !transcript || remote || direction === stoppedDirection) return;
    if (view.performance.now() - lastRequestAt < 16) return;
    if (term.modes.mouseTrackingMode === "none" || term.modes.mouseTrackingMode === "x10") return;
    lastRequestAt = view.performance.now();
    remote = { direction, started: Date.now() };
    // Use xterm's wheel encoder rather than hardcoding an escape sequence.
    // A line-mode delta emits one wheel report, with no held button/modifiers.
    const rect = screen.getBoundingClientRect();
    sendingWheel = true;
    try {
      screen.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, deltaMode: 1, deltaY: direction,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      }));
    } finally {
      sendingWheel = false;
    }
    // This gesture has only one outstanding report. Waiting for the normal
    // wheel-burst frame would add another display frame to every SSH round trip.
    options.flushInput?.();
  };
  const tick = () => {
    if (!active) return false;
    const rect = screen.getBoundingClientRect();
    const direction = point.y <= rect.top + 12 ? -1 : point.y >= rect.bottom - 12 ? 1 : 0;
    if (!direction) {
      stoppedDirection = 0;
      return false;
    }
    if (stoppedDirection !== direction) stoppedDirection = 0;
    // Wait for a response instead of flooding a slow SSH link or skipping pages.
    if (remote && Date.now() - remote.started > 1200) {
      stoppedDirection = remote.direction;
      // Retain the in-flight snapshot so even a late SSH response can finish
      // this selection. A deliberate direction change can retry at a boundary.
      if (direction !== remote.direction) {
        remote = null;
        stoppedDirection = 0;
      }
    }
    requestScroll(direction);
    return true;
  };
  const scheduleFrame = () => {
    if (frame !== undefined || disposed) return;
    frame = view.requestAnimationFrame(() => {
      frame = undefined;
      if (needsDraw && transcript) {
        needsDraw = false;
        const moved = transcript.move(endpoint());
        if (moved || frameChanged) draw();
        frameChanged = false;
      }
      if (finishAfterDraw) {
        finishAfterDraw = false;
        if (hasSelection()) options.onFinish(point.x, point.y);
      }
      if (tick()) scheduleFrame();
    });
  };

  const begin = (event: MouseEvent) => {
    transcript = new SelectionTranscript(pendingFrame ?? captureFrame(), coords(event.clientX, event.clientY), event.altKey);
    columnMode = event.altKey;
    pendingFrame = null;
    active = true;
    pendingDown = null;
    stoppedDirection = 0;
    term.focus();
    stopTimer();
    scheduleFrame();
  };
  const onDown = (event: MouseEvent) => {
    if (replayingClick) return;
    if (event.button === 2 && hasSelection()) {
      // Keep the selection when opening the browser's copy menu.
      event.stopPropagation();
      return;
    }
    if (event.button !== 0) return;
    point = { x: event.clientX, y: event.clientY };
    if (term.modes.mouseTrackingMode === "none" && !transcript) {
      nativeDown = true;
      return;
    }
    clear();
    nativeDown = true;
    if (term.modes.mouseTrackingMode === "none") return;
    customGesture = true;
    if (event.shiftKey || event.altKey) {
      begin(event);
      event.preventDefault();
      event.stopImmediatePropagation();
    } else {
      // Defer the click until release. A press that becomes a drag must not
      // activate a TUI button or change the output under the selection anchor.
      pendingDown = event;
      pendingFrame = captureFrame();
      term.focus();
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const onMove = (event: MouseEvent) => {
    if ((event.buttons & 1) === 0) {
      if (active || pendingDown) release();
      return;
    }
    if (pendingDown) {
      const dx = event.clientX - pendingDown.clientX;
      const dy = event.clientY - pendingDown.clientY;
      if (dx * dx + dy * dy > 16) begin(pendingDown);
    }
    if (!active || !transcript) return;
    point = { x: event.clientX, y: event.clientY };
    needsDraw = true;
    scheduleFrame();
    // Selection gestures never become remote button/drag reports.
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onUp = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const finishing = nativeDown || active || pendingDown !== null;
    nativeDown = false;
    if (!finishing) return;
    if (customGesture && !pendingDown) event.stopImmediatePropagation();
    customGesture = false;
    if (pendingDown) {
      const origin = pendingDown;
      replayingClick = true;
      try {
        screen.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true, cancelable: true, button: 0, buttons: 1, detail: origin.detail,
          clientX: origin.clientX, clientY: origin.clientY,
          ctrlKey: origin.ctrlKey, metaKey: origin.metaKey,
        }));
      } finally {
        replayingClick = false;
      }
      // The real mouseup continues to xterm, balancing the replayed press.
    }
    pendingDown = null;
    pendingFrame = null;
    active = false;
    stopTimer();
    point = { x: event.clientX, y: event.clientY };
    if (transcript) {
      transcript.move(endpoint());
      draw();
    }
    view.clearTimeout(finishTimer);
    finishTimer = view.setTimeout(() => {
      if (!disposed && hasSelection()) options.onFinish(event.clientX, event.clientY);
    }, 0);
  };
  function release() {
    if (!active && !pendingDown) return;
    // Cancel a pending click on blur or a missed release instead of activating
    // the TUI as the user switches windows.
    pendingDown = null;
    pendingFrame = null;
    host.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, button: 0, clientX: point.x, clientY: point.y,
    }));
  }
  const onWheel = (event: WheelEvent) => {
    if (sendingWheel) return;
    if (active && transcript) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.deltaY) requestScroll(event.deltaY < 0 ? -1 : 1);
    } else if (transcript) {
      clear();
    }
  };
  const onCopy = (event: ClipboardEvent) => {
    if (!transcript || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", transcript.getText());
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onKey = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "c") return;
    if (["shift", "alt", "control", "meta"].includes(key)) return;
    if (transcript) clear();
  };
  const captureRemote = (complete = false) => {
    parseTimer = undefined;
    if (!remote || !transcript || synchronizedRepaint) return;
    if (disposed) return;
    const result = transcript.scroll(captureFrame(), remote.direction, complete);
    if (result === "moved") {
      remote = null;
      stoppedDirection = 0;
      needsDraw = true;
      frameChanged = true;
      finishAfterDraw = !active;
      // Continue as soon as the complete response is verified. Highlighting
      // still draws once per frame, and requests remain bounded to one at a time.
      tick();
      scheduleFrame();
    } else if (result === "limit") {
      remote = null;
      captureStopped = true;
      stopTimer();
      options.onLimit();
    }
    // Partial/unrelated repaints retain the last verified snapshot.
  };
  const parsed = term.onWriteParsed(() => {
    const complete = completedRepaint;
    completedRepaint = false;
    if (!remote || !transcript || synchronizedRepaint) return;
    if (complete) {
      view.clearTimeout(parseTimer);
      captureRemote(true);
    } else if (parseTimer === undefined) {
      // A bounded trailing check also runs during continuous output. Restarting
      // a debounce on every SSH chunk could starve selection indefinitely.
      parseTimer = view.setTimeout(captureRemote, 4);
    }
  });
  // Modern TUIs bracket a repaint with DEC synchronized-output mode. A slow
  // connection can split that repaint into many writes; never align half of it.
  const syncStart = term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    if (params.includes(2026)) {
      view.clearTimeout(parseTimer);
      parseTimer = undefined;
      synchronizedRepaint = true;
      completedRepaint = false;
    }
    return false;
  });
  const syncEnd = term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (params.includes(2026)) {
      synchronizedRepaint = false;
      completedRepaint = true;
    }
    return false;
  });
  const selection = term.onSelectionChange(notify);
  const resized = term.onResize(() => {
    release();
    // Rows can reflow at a new width. Preserve captured text, stop alignment.
    remote = null;
    stopTimer();
  });
  host.addEventListener("mousedown", onDown, true);
  host.addEventListener("wheel", onWheel, { capture: true, passive: false });
  host.addEventListener("copy", onCopy, true);
  host.addEventListener("keydown", onKey, true);
  doc.addEventListener("mousemove", onMove, true);
  doc.addEventListener("mouseup", onUp, true);
  view.addEventListener("blur", release);

  return {
    getText,
    clear,
    dispose() {
      release();
      disposed = true;
      stopTimer();
      view.clearTimeout(parseTimer);
      view.clearTimeout(finishTimer);
      columnOverlay?.remove();
      parsed.dispose();
      syncStart.dispose();
      syncEnd.dispose();
      selection.dispose();
      resized.dispose();
      host.removeEventListener("mousedown", onDown, true);
      host.removeEventListener("wheel", onWheel, true);
      host.removeEventListener("copy", onCopy, true);
      host.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("mousemove", onMove, true);
      doc.removeEventListener("mouseup", onUp, true);
      view.removeEventListener("blur", release);
    },
  };
}
