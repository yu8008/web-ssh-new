import type { IMarker, Terminal } from "xterm";
import { captureSelectionRows, SelectionTranscript, type SelectionPoint, type SelectionRow } from "./selectionTranscript";
import { createSelectionAnimation } from "./terminalSelectionAnimation";
import { terminalDragScroll } from "./terminalDragScroll";

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
  const viewport = host.querySelector<HTMLElement>(".xterm-viewport")!;
  const animation = createSelectionAnimation(term, screen, () => transcript?.getScrollRange() ?? null);
  let nativeScrolling = false;
  let nativeViewportY = term.buffer.active.viewportY;
  let nativeScrollAt = view.performance.now();
  let nativeAnchor: { row: number; col: number; marker?: IMarker } | null = null;
  let nativeColumn = false;
  let nativeOriginY = 0;
  let nativeRemainder = 0;
  let nativeTickAt = 0;
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
  let remote: { direction: -1 | 1; started: number; retryAt: number; attempts: number; reports: number; issued: number; expected: number; moved: number } | null = null;
  const reportTimers = new Set<number>();
  let responseTime = 0;
  let scrollStep = 0;
  let scrollHeight = 0;
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
    animation.updateSelection();
    notify();
  };

  const stopTimer = () => {
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    needsDraw = false;
    frameChanged = false;
    finishAfterDraw = false;
  };
  const stopQueuedReports = () => {
    reportTimers.forEach((timer) => view.clearTimeout(timer));
    reportTimers.clear();
    if (remote && remote.issued < remote.reports) {
      remote.reports = remote.issued;
      remote.expected = remote.issued * scrollStep;
      if (remote.moved >= remote.expected) { remote = null; animation.prepare(false); }
    }
  };
  const stopNative = () => {
    nativeAnchor?.marker?.dispose();
    nativeAnchor = null;
    nativeRemainder = nativeTickAt = 0;
  };
  const clear = () => {
    stopQueuedReports();
    stopNative();
    animation.cancel();
    nativeScrolling = false;
    active = false;
    pendingDown = null;
    pendingFrame = null;
    nativeDown = false;
    customGesture = false;
    transcript = null;
    remote = null;
    scrollStep = scrollHeight = 0;
    captureStopped = false;
    stopTimer();
    view.clearTimeout(parseTimer);
    parseTimer = undefined;
    columnOverlay?.remove();
    columnOverlay = null;
    term.clearSelection();
    notify();
  };

  const requestScroll = (direction: -1 | 1, retry = false, drag = true) => {
    if (!active || disposed || captureStopped || !transcript || (remote && !retry)) return;
    if (view.performance.now() - lastRequestAt < 16) return;
    if (term.modes.mouseTrackingMode === "none" || term.modes.mouseTrackingMode === "x10") return;
    lastRequestAt = view.performance.now();
    const now = Date.now();
    const attempts = retry && remote ? remote.attempts + 1 : 1;
    const rect = screen.getBoundingClientRect();
    const motion = terminalDragScroll(point.y, rect.top, rect.bottom, term.rows, columnMode ? 12 : 48);
    // Learn the TUI's actual wheel distance before accelerating. Keep at least
    // overlapping rows and wait for the burst before sending more. Pacing
    // reports prevents TUIs from folding an immediate burst into one wheel.
    // Finish issuing before its first reply; fast links are quicker with one
    // report per verified frame and cannot expose overlapping partial repaints.
    const budget = Math.min(scrollHeight - 2, Math.floor(scrollHeight * 0.7));
    const reports = !retry && drag && scrollStep
      ? Math.max(1, Math.min(8, Math.floor(responseTime / 40), Math.ceil(motion.speed * responseTime / 1000 / scrollStep), Math.floor(budget / scrollStep))) : 1;
    remote = {
      direction, started: retry && remote ? remote.started : now, attempts,
      retryAt: now + Math.max(responseTime * 4, Math.min(10000, 2500 * 2 ** Math.min(attempts - 1, 2))),
      reports: retry && remote ? remote.reports : reports,
      issued: retry && remote ? remote.issued : 0,
      expected: retry && remote ? remote.expected : scrollStep * reports,
      moved: retry && remote ? remote.moved : 0,
    };
    animation.prepare();
    // Use xterm's wheel encoder rather than hardcoding an escape sequence.
    // A line-mode delta emits one wheel report, with no held button/modifiers.
    const request = remote;
    const sendReport = () => {
      if (remote !== request) return;
      if (!retry) request.issued++;
      sendingWheel = true;
      try {
        screen.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true, cancelable: true, deltaMode: 1, deltaY: direction,
          clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
        }));
      } finally { sendingWheel = false; }
      options.flushInput?.();
    };
    sendReport();
    for (let report = 1; report < reports; report++) {
      const timer = view.setTimeout(() => { reportTimers.delete(timer); sendReport(); }, report * 40);
      reportTimers.add(timer);
    }
  };
  const tick = () => {
    if (!active || !transcript?.hasSelection()) return false;
    const rect = screen.getBoundingClientRect();
    const direction = terminalDragScroll(point.y, rect.top, rect.bottom, term.rows, columnMode ? 12 : 48).direction;
    if (!direction) return false;
    // A TUI may ignore a wheel (or repaint without moving). Keep the verified
    // snapshot for late responses, but don't permanently latch the gesture.
    // Back off at boundaries and on slow links; never retry inside a split
    // synchronized repaint, where another wheel could skip uncaptured output.
    if (remote && Date.now() >= remote.retryAt && !synchronizedRepaint) {
      if (direction === remote.direction) requestScroll(direction as -1 | 1, true);
      else remote = null;
    }
    requestScroll(direction as -1 | 1);
    return true;
  };
  const tickNative = () => {
    if (!nativeDown || !nativeScrolling || nativeColumn || term.buffer.active.type !== "normal") return false;
    const rect = screen.getBoundingClientRect();
    const motion = terminalDragScroll(point.y, rect.top, rect.bottom, term.rows);
    const now = view.performance.now();
    const elapsed = nativeTickAt ? Math.min(64, now - nativeTickAt) : 0;
    nativeTickAt = now;
    if (!nativeAnchor && motion.direction && Math.abs(point.y - nativeOriginY) > 4) {
      const selection = term.getSelectionPosition();
      if (selection) {
        const anchor = motion.direction > 0 ? selection.start : selection.end;
        nativeAnchor = {
          row: anchor.y, col: anchor.x,
          marker: term.registerMarker(anchor.y - term.buffer.active.baseY - term.buffer.active.cursorY),
        };
      }
    }
    if (!nativeAnchor) { nativeTickAt = 0; return false; }
    if (motion.direction) {
      nativeRemainder += motion.direction * motion.speed * elapsed / 1000;
      const lines = Math.trunc(nativeRemainder);
      nativeRemainder -= lines;
      if (lines) {
        const duration = term.options.smoothScrollDuration;
        term.options.smoothScrollDuration = 0;
        try { term.scrollToLine(term.buffer.active.viewportY + lines); }
        finally { term.options.smoothScrollDuration = duration; }
      }
    } else nativeRemainder = 0;
    const end = coords(point.x, point.y);
    end.row += term.buffer.active.viewportY;
    if (motion.direction) end.col = motion.direction > 0 ? term.cols : 0;
    const cell = term.buffer.active.getLine(end.row)?.getCell(end.col);
    if (cell?.getWidth() === 0) end.col++;
    const anchor = { row: nativeAnchor.marker?.isDisposed ? 0 : nativeAnchor.marker?.line ?? nativeAnchor.row, col: nativeAnchor.col };
    const start = anchor.row < end.row || (anchor.row === end.row && anchor.col <= end.col) ? anchor : end;
    const last = start === anchor ? end : anchor;
    // Public select stops xterm's independent 50ms drag timer. This controller
    // owns both scrolling and the endpoint from now until the release.
    term.select(start.col, start.row, (last.row - start.row) * term.cols + last.col - start.col);
    if (!motion.direction) nativeTickAt = 0;
    return !!motion.direction;
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
      if (nativeDown && nativeScrolling && !transcript) {
        const scrolling = tickNative();
        animation.updateSelection();
        if (scrolling) scheduleFrame();
      }
      if (tick()) scheduleFrame();
    });
  };

  const begin = (event: MouseEvent) => {
    transcript = new SelectionTranscript(pendingFrame ?? captureFrame(), coords(event.clientX, event.clientY), event.altKey);
    columnMode = event.altKey;
    pendingFrame = null;
    active = true;
    nativeScrolling = false;
    animation.start();
    pendingDown = null;
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
    stopNative();
    nativeColumn = event.altKey;
    nativeOriginY = event.clientY;
    if (term.modes.mouseTrackingMode === "none" && !transcript) {
      nativeDown = true;
      nativeScrolling = true;
      nativeViewportY = term.buffer.active.viewportY;
      nativeScrollAt = view.performance.now();
      animation.start();
      return;
    }
    clear();
    nativeDown = true;
    if (term.modes.mouseTrackingMode === "none") {
      nativeScrolling = true;
      nativeViewportY = term.buffer.active.viewportY;
      nativeScrollAt = view.performance.now();
      animation.start();
      return;
    }
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
      if (nativeDown || active || pendingDown) release();
      return;
    }
    if (nativeDown && nativeScrolling && !transcript) {
      point = { x: event.clientX, y: event.clientY };
      scheduleFrame();
      if (nativeAnchor) { event.preventDefault(); event.stopImmediatePropagation(); }
      return;
    }
    if (pendingDown) {
      const dx = event.clientX - pendingDown.clientX;
      const dy = event.clientY - pendingDown.clientY;
      if (dx * dx + dy * dy > 16) begin(pendingDown);
    }
    if (!active || !transcript) return;
    point = { x: event.clientX, y: event.clientY };
    const bounds = screen.getBoundingClientRect();
    if (remote && terminalDragScroll(point.y, bounds.top, bounds.bottom, term.rows, columnMode ? 12 : 48).direction !== remote.direction) stopQueuedReports();
    needsDraw = true;
    scheduleFrame();
    // Selection gestures never become remote button/drag reports.
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onUp = (event: MouseEvent) => {
    if (event.button !== 0) return;
    point = { x: event.clientX, y: event.clientY };
    const finishing = nativeDown || active || pendingDown !== null;
    if (nativeAnchor) { tickNative(); animation.updateSelection(); }
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
    stopQueuedReports();
    stopNative();
    stopTimer();
    point = { x: event.clientX, y: event.clientY };
    if (transcript) {
      transcript.move(endpoint());
      draw();
    }
    animation.finish();
    view.clearTimeout(finishTimer);
    finishTimer = view.setTimeout(() => {
      if (!disposed && hasSelection()) options.onFinish(event.clientX, event.clientY);
    }, 0);
  };
  function release() {
    if (!nativeDown && !active && !pendingDown) return;
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
      if (event.deltaY) requestScroll(event.deltaY < 0 ? -1 : 1, false, false);
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
    const nextFrame = captureFrame();
    const result = transcript.scroll(nextFrame, remote.direction, complete);
    if (result === "moved") {
      const elapsed = Date.now() - remote.started;
      const motion = transcript.scrollMotion!;
      const lines = Math.abs(motion.lines);
      remote.moved += lines;
      const completeBurst = remote.issued === remote.reports && (remote.reports === 1 || remote.moved >= remote.expected);
      if (completeBurst && remote.attempts === 1) {
        responseTime = responseTime ? responseTime * 0.75 + elapsed * 0.25 : elapsed;
        scrollStep = Math.max(scrollStep, remote.moved / remote.reports);
      }
      scrollHeight = motion.bottom - motion.top;
      const interval = elapsed * Math.min(1, lines / Math.max(lines, remote.expected));
      animation.move(motion, remote.attempts === 1 ? interval : responseTime || 100, nextFrame);
      if (completeBurst) { remote = null; stopQueuedReports(); }
      else animation.prepare();
      needsDraw = true;
      frameChanged = true;
      finishAfterDraw = !active;
      // Continue as soon as the complete response is verified. Highlighting
      // still draws once per frame, and bursts remain bounded to one at a time.
      tick();
      scheduleFrame();
    } else if (result === "limit") {
      animation.cancel();
      remote = null;
      captureStopped = true;
      stopTimer();
      options.onLimit();
    }
    // Partial/unrelated repaints retain the last verified snapshot.
  };
  const parsed = term.onWriteParsed(() => {
    animation.invalidate();
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
  // Several repaints can share one parsed SSH batch. Capture the preceding
  // frame before a new home-and-redraw starts, rather than aligning its lower
  // half with the next frame's upper half in onWriteParsed.
  const repaintStart = term.parser.registerCsiHandler({ final: "H" }, (params) => {
    if ((params[0] || 1) === 1 && (params[1] || 1) === 1 && remote && !synchronizedRepaint) {
      view.clearTimeout(parseTimer);
      captureRemote();
    }
    return false;
  });
  const selection = term.onSelectionChange(() => { animation.updateSelection(); notify(); });
  const onNativeScroll = () => {
    if (!nativeScrolling || term.buffer.active.type !== "normal") return;
    const next = term.buffer.active.viewportY;
    if (next !== nativeViewportY) {
      const now = view.performance.now();
      animation.move({ top: 0, bottom: term.rows, lines: next - nativeViewportY }, now - nativeScrollAt);
      nativeViewportY = next;
      nativeScrollAt = now;
    }
  };
  // xterm suppresses its public onScroll event for viewport-originated scrolls.
  // Listen after its DOM scroll handler, when viewportY has been updated.
  viewport.addEventListener("scroll", onNativeScroll, { passive: true });
  const scrolled = term.onScroll(onNativeScroll);
  const resized = term.onResize(() => {
    release();
    animation.cancel();
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
  const onBlur = () => { release(); animation.cancel(); };
  view.addEventListener("blur", onBlur);

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
      animation.dispose();
      parsed.dispose();
      syncStart.dispose();
      syncEnd.dispose();
      repaintStart.dispose();
      selection.dispose();
      scrolled.dispose();
      viewport.removeEventListener("scroll", onNativeScroll);
      resized.dispose();
      host.removeEventListener("mousedown", onDown, true);
      host.removeEventListener("wheel", onWheel, true);
      host.removeEventListener("copy", onCopy, true);
      host.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("mousemove", onMove, true);
      doc.removeEventListener("mouseup", onUp, true);
      view.removeEventListener("blur", onBlur);
    },
  };
}
