import type { IMarker, Terminal } from "@xterm/xterm";
import { captureSelectionRows, SelectionTranscript, type SelectionPoint, type SelectionRow } from "./selectionTranscript";
import { dispatchTerminalWheel, isLocalTerminalHistory, isTerminalWheelReport } from "./terminalWheel";
import { terminalDragScroll } from "./terminalDragScroll";
import { createTerminalSelectionHighlight } from "./terminalSelectionHighlight";

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
  const highlight = createTerminalSelectionHighlight(term, screen);
  let nativeScrolling = false;
  let nativeAnchor: { row: number; col: number; marker?: IMarker } | null = null;
  let nativeColumn = false;
  let nativeOriginY = 0;
  let nativeRemainder = 0;
  let nativeTickAt = 0;
  let transcript: SelectionTranscript | null = null;
  let displayedFrame: readonly SelectionRow[] | undefined;
  let pendingDown: MouseEvent | null = null;
  let pendingFrame: SelectionRow[] | null = null;
  let replayingClick = false;
  let forwardingLocalMove = false;
  let customGesture = false;
  let columnMode = false;
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
  let remote: { direction: -1 | 1; started: number; retryAt: number; attempts: number; issued: number; moved: number } | null = null;
  let reportTimer: number | undefined;
  let responseTime = 0;
  let scrollStep = 0;
  let scrollHeight = 0;
  let sendingWheel = false;
  let lastRequestAt = -Infinity;
  let reportInterval = 8;
  let dragCredit = 0;
  let dragTickAt = 0;
  let dragDirection = 0;
  let fastSince = 0;
  let fastDirection = 0;
  let pendingFocus = false;
  let contextCopy = false;
  let completedRepaint = false;
  let captureStopped = false;
  let disposed = false;
  let capturedFrame: SelectionRow[] = [];
  let renderedFrame: SelectionRow[] = [];
  const captureFrame = () => (capturedFrame = captureSelectionRows(term, capturedFrame));
  const selectionFrame = () => renderedFrame.length === term.rows ? renderedFrame : captureFrame();

  const dragMotion = (now = view.performance.now()) => {
    const rect = screen.getBoundingClientRect();
    const args = [point.y, rect.top, rect.bottom, term.rows, columnMode ? 12 : 48] as const;
    const motion = terminalDragScroll(...args);
    if (!motion.fast || motion.direction !== fastDirection) fastSince = now;
    fastDirection = motion.fast ? motion.direction : 0;
    return terminalDragScroll(...args, motion.fast ? now - fastSince : 0);
  };
  const scrollWindow = (speed: number) => {
    const step = scrollStep || 2;
    // Keep roughly three quarters of the scrolling body available to align
    // successive frames. Until the first response, send only one probe.
    if (!scrollStep) return step;
    const overlapLimit = Math.min(12, Math.ceil(scrollHeight / 4));
    return Math.max(step, Math.min(overlapLimit, speed >= 180 ? 12 : 4));
  };

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
    if (captureStopped) { highlight.hide(); return; }
    highlight.draw(transcript.getVisibleRange(displayedFrame), columnMode);
    notify();
  };
  const focus = () => {
    // DOM focus can repaint a row directly. Defer it while a synchronized
    // frame is incomplete, just as we defer presentation of the new selection.
    if (term.modes.synchronizedOutputMode) pendingFocus = true;
    else { pendingFocus = false; if (doc.activeElement !== term.textarea) term.focus(); }
  };

  const stopTimer = () => {
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    needsDraw = false;
    finishAfterDraw = false;
  };
  const stopQueuedReports = () => {
    view.clearTimeout(reportTimer);
    reportTimer = undefined;
  };
  const stopNative = () => {
    nativeAnchor?.marker?.dispose();
    nativeAnchor = null;
    nativeRemainder = nativeTickAt = 0;
    fastSince = fastDirection = 0;
  };
  const clear = () => {
    stopQueuedReports();
    stopNative();
    nativeScrolling = false;
    active = false;
    pendingDown = null;
    pendingFrame = null;
    nativeDown = false;
    customGesture = false;
    transcript = null;
    displayedFrame = undefined;
    remote = null;
    scrollStep = scrollHeight = 0;
    reportInterval = 8;
    dragCredit = dragTickAt = dragDirection = 0;
    frameChanged = false;
    pendingFocus = false;
    if (contextCopy && term.textarea) term.textarea.value = "";
    contextCopy = false;
    captureStopped = false;
    stopTimer();
    view.clearTimeout(parseTimer);
    parseTimer = undefined;
    highlight.hide();
    if (term.hasSelection()) term.clearSelection();
    notify();
  };

  const scheduleReport = (milliseconds: number) => {
    if (reportTimer !== undefined) return;
    reportTimer = view.setTimeout(() => {
      reportTimer = undefined;
      if (tick()) scheduleFrame();
    }, Math.max(8, milliseconds));
  };
  const requestScroll = (direction: -1 | 1, retry = false, drag = true) => {
    if (!active || disposed || captureStopped || !transcript) return;
    if (remote && (remote.direction !== direction || (!scrollStep && !retry))) return;
    // Parsed movement does not free window space until its text and highlight
    // have reached the renderer together.
    if (frameChanged) return;
    if (term.modes.synchronizedOutputMode) return;
    if (term.modes.mouseTrackingMode === "none" || term.modes.mouseTrackingMode === "x10") return;
    const clock = view.performance.now();
    const motion = dragMotion(clock);
    const step = scrollStep || 2;
    const interval = Math.max(reportInterval, Math.min(64, 1000 * step / Math.max(1, motion.speed)));
    const wait = interval - (clock - lastRequestAt);
    if (wait > 0) { if (drag) scheduleReport(wait); return; }
    if (!retry) {
      if (drag && dragCredit < step) {
        scheduleReport(1000 * (step - dragCredit) / Math.max(1, motion.speed));
        return;
      }
      const outstanding = remote ? remote.issued * step - remote.moved : 0;
      if (outstanding + step > scrollWindow(motion.speed)) return;
    }
    const now = Date.now();
    const attempts = retry && remote ? remote.attempts + 1 : 1;
    const rect = screen.getBoundingClientRect();
    lastRequestAt = clock;
    // Some TUIs fold closely spaced wheel reports into one action. If a full
    // window stops progressing, recover with a slower cadence for this gesture.
    if (retry) reportInterval = Math.min(64, Math.max(16, reportInterval * 2));
    if (drag && !retry) dragCredit = Math.max(0, dragCredit - step);
    if (!remote) remote = { direction, started: now, attempts: 1, retryAt: 0, issued: 0, moved: 0 };
    if (!retry) remote.issued++;
    remote.attempts = attempts;
    // A full window with no progress backs off instead of accumulating input.
    if (remote.issued === 1 || retry) remote.retryAt = now + Math.min(2000,
      (responseTime ? Math.max(150, responseTime * 2.5) : 2000) * 2 ** Math.min(attempts - 1, 2));
    // Use xterm's wheel encoder rather than hardcoding an escape sequence.
    // A line-mode delta emits one wheel report, with no held button/modifiers.
    sendingWheel = true;
    try {
      dispatchTerminalWheel(term, screen, {
        deltaY: direction,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      });
    } finally { sendingWheel = false; }
    options.flushInput?.();
    if (drag) scheduleReport(interval);
  };
  const tick = () => {
    if (!active || captureStopped || !transcript?.hasSelection()) return false;
    const now = view.performance.now();
    const motion = dragMotion(now);
    const { direction } = motion;
    const elapsed = dragTickAt && direction === dragDirection ? Math.min(32, now - dragTickAt) : 0;
    if (direction !== dragDirection) dragCredit = 0;
    dragDirection = direction;
    dragTickAt = direction ? now : 0;
    if (!direction) { dragCredit = 0; stopQueuedReports(); return false; }
    dragCredit = Math.min(scrollWindow(motion.speed), dragCredit + motion.speed * elapsed / 1000);
    // A TUI may ignore a wheel (or repaint without moving). Keep the verified
    // snapshot for late responses, but don't permanently latch the gesture.
    // Back off at boundaries and on slow links; never retry inside a split
    // synchronized repaint, where another wheel could skip uncaptured output.
    if (remote && Date.now() >= remote.retryAt && !term.modes.synchronizedOutputMode) {
      if (direction === remote.direction) requestScroll(direction as -1 | 1, true);
      else remote = null;
    }
    requestScroll(direction as -1 | 1);
    return true;
  };
  const tickNative = () => {
    if (!nativeDown || !nativeScrolling || nativeColumn || term.buffer.active.type !== "normal") return false;
    const now = view.performance.now();
    const motion = dragMotion(now);
    const elapsed = nativeTickAt ? Math.min(32, now - nativeTickAt) : 0;
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
      if (Math.sign(nativeRemainder) !== motion.direction) nativeRemainder = 0;
      const limit = Math.min(6, Math.max(1, Math.floor(term.rows / 4))) + 0.999;
      nativeRemainder = Math.max(-limit, Math.min(limit, nativeRemainder + motion.direction * motion.speed * elapsed / 1000));
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
        const moved = transcript.move(endpoint(), displayedFrame);
        if (moved) draw();
      }
      if (finishAfterDraw && !frameChanged) {
        finishAfterDraw = false;
        if (hasSelection()) options.onFinish(point.x, point.y);
      }
      if (nativeDown && nativeScrolling && !transcript) {
        const scrolling = tickNative();
        if (scrolling) scheduleFrame();
      }
      if (tick()) scheduleFrame();
    });
  };

  const begin = (event: MouseEvent) => {
    transcript = new SelectionTranscript(pendingFrame ?? selectionFrame(), coords(event.clientX, event.clientY), event.altKey);
    displayedFrame = transcript.frameRows;
    frameChanged = false;
    columnMode = event.altKey;
    pendingFrame = null;
    active = true;
    nativeScrolling = false;
    pendingDown = null;
    focus();
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
      return;
    }
    clear();
    nativeDown = true;
    if (term.modes.mouseTrackingMode === "none" || isLocalTerminalHistory(term)) {
      nativeScrolling = true;
      if (term.modes.mouseTrackingMode !== "none") {
        // Use xterm's native selection in local scrollback even when the live
        // application enabled mouse reporting. Force only this press, leaving
        // the application's negotiated mouse modes untouched.
        const mac = /Mac/.test(view.navigator.platform);
        const forceOption = term.options.macOptionClickForcesSelection;
        if (mac) term.options.macOptionClickForcesSelection = true;
        replayingClick = true;
        try {
          screen.dispatchEvent(new MouseEvent("mousedown", {
            bubbles: true, cancelable: true, button: 0, buttons: 1,
            detail: event.detail || 1, clientX: event.clientX, clientY: event.clientY,
            shiftKey: true, altKey: mac || event.altKey,
            ctrlKey: event.ctrlKey, metaKey: event.metaKey,
          }));
        } finally {
          replayingClick = false;
          if (mac) term.options.macOptionClickForcesSelection = forceOption;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
      }
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
      pendingFrame = selectionFrame();
      focus();
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const onMove = (event: MouseEvent) => {
    if (forwardingLocalMove) return;
    if ((event.buttons & 1) === 0) {
      if (nativeDown || active || pendingDown) release();
      // Coordinates in local history do not belong to the live application.
      // ANY mouse reporting would otherwise both repaint it and jump to tail.
      if (isLocalTerminalHistory(term) && term.modes.mouseTrackingMode !== "none" && event.target instanceof Node && host.contains(event.target)) {
        event.stopImmediatePropagation();
      }
      return;
    }
    if (nativeDown && nativeScrolling && !transcript) {
      point = { x: event.clientX, y: event.clientY };
      dragMotion();
      scheduleFrame();
      if (term.modes.mouseTrackingMode !== "none") {
        // SelectionService listens on the document. Deliver its local move
        // there without allowing xterm's application mouse listener to see it.
        if (!nativeAnchor) {
          forwardingLocalMove = true;
          try {
            doc.dispatchEvent(new MouseEvent("mousemove", {
              bubbles: true, buttons: event.buttons, clientX: event.clientX, clientY: event.clientY,
              shiftKey: event.shiftKey, altKey: event.altKey,
            }));
          } finally { forwardingLocalMove = false; }
        }
        event.preventDefault();
        event.stopImmediatePropagation();
      } else if (nativeAnchor) { event.preventDefault(); event.stopImmediatePropagation(); }
      return;
    }
    if (pendingDown) {
      const dx = event.clientX - pendingDown.clientX;
      const dy = event.clientY - pendingDown.clientY;
      if (dx * dx + dy * dy > 16) begin(pendingDown);
    }
    if (!active || !transcript) return;
    point = { x: event.clientX, y: event.clientY };
    const motion = dragMotion();
    if (motion.direction !== dragDirection) {
      dragCredit = dragTickAt = 0;
      stopQueuedReports();
    }
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
    if (nativeAnchor) tickNative();
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
      transcript.move(endpoint(), displayedFrame);
      draw();
      finishAfterDraw = frameChanged;
    }
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
    if (sendingWheel || isTerminalWheelReport(event)) return;
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
  const onContextMenu = (event: MouseEvent) => {
    if (!transcript?.hasSelection() || !term.textarea) return;
    // Native context-menu copy needs a selected textarea too. Populate it from
    // the frozen transcript rather than xterm's intentionally empty selection.
    event.stopImmediatePropagation();
    const rect = screen.getBoundingClientRect();
    Object.assign(term.textarea.style, {
      width: "20px", height: "20px", zIndex: "1000",
      left: `${event.clientX - rect.left - 10}px`, top: `${event.clientY - rect.top - 10}px`,
    });
    focus();
    term.textarea.value = transcript.getText();
    term.textarea.setSelectionRange(0, term.textarea.value.length);
    contextCopy = true;
  };
  const onKey = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "c") return;
    if (["shift", "alt", "control", "meta"].includes(key)) return;
    if (transcript) clear();
  };
  const captureRemote = (complete = false) => {
    parseTimer = undefined;
    if (!remote || !transcript || term.modes.synchronizedOutputMode) return;
    if (disposed) return;
    const nextFrame = captureFrame();
    const result = transcript.scroll(nextFrame, remote.direction, complete);
    if (result === "moved") {
      const elapsed = Date.now() - remote.started;
      const motion = transcript.scrollMotion!;
      const lines = Math.abs(motion.lines);
      remote.moved += lines;
      responseTime = responseTime ? responseTime * 0.75 + elapsed * 0.25 : elapsed;
      const completeWindow = !scrollStep || remote.moved >= remote.issued * scrollStep;
      if (completeWindow && remote.attempts === 1) {
        scrollStep = Math.max(scrollStep, remote.moved / remote.issued);
      }
      scrollHeight = motion.bottom - motion.top;
      if (completeWindow) remote = null;
      else {
        remote.started = Date.now();
        remote.retryAt = remote.started + Math.min(2000, Math.max(150, responseTime * 2.5));
      }
      needsDraw = true;
      frameChanged = true;
      finishAfterDraw = !active;
      // Keep time accounting current. Window space is reused only after this
      // verified frame has actually reached the renderer.
      tick();
      scheduleFrame();
    } else if (result === "limit") {
      remote = null;
      captureStopped = true;
      stopQueuedReports();
      stopTimer();
      options.onLimit();
    }
    // Partial/unrelated repaints retain the last verified snapshot.
  };
  const parsed = term.onWriteParsed(() => {
    const complete = completedRepaint;
    completedRepaint = false;
    if (!remote || !transcript || term.modes.synchronizedOutputMode) return;
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
      completedRepaint = false;
    }
    return false;
  });
  const syncEnd = term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (params.includes(2026)) {
      completedRepaint = true;
    }
    return false;
  });
  // Several repaints can share one parsed SSH batch. Capture the preceding
  // frame before a new home-and-redraw starts, rather than aligning its lower
  // half with the next frame's upper half in onWriteParsed.
  const repaintStart = term.parser.registerCsiHandler({ final: "H" }, (params) => {
    if ((params[0] || 1) === 1 && (params[1] || 1) === 1 && remote && !term.modes.synchronizedOutputMode) {
      view.clearTimeout(parseTimer);
      captureRemote();
    }
    return false;
  });
  const selection = term.onSelectionChange(notify);
  const rendered = term.onRender(() => {
    if (term.modes.synchronizedOutputMode) return;
    if (term.modes.mouseTrackingMode !== "none") renderedFrame = captureFrame();
    // An unsynchronized repaint may render before the 4ms alignment timer.
    // Align here too, so highlighting does not wait for another remote frame.
    if (remote && transcript) captureRemote();
    if (pendingFocus) focus();
    // The renderer has committed the new text. Update the matching highlight
    // synchronously in the same animation frame, without asking it to repaint.
    if (transcript && frameChanged) {
      displayedFrame = transcript.frameRows;
      frameChanged = needsDraw = false;
      transcript.move(endpoint(), displayedFrame);
      draw();
      if (finishAfterDraw) {
        finishAfterDraw = false;
        if (hasSelection()) options.onFinish(point.x, point.y);
      }
    } else if (transcript) draw();
  });
  const resized = term.onResize(() => {
    release();
    // Rows can reflow at a new width. Preserve captured text, stop alignment.
    remote = null;
    stopTimer();
    frameChanged = false;
    captureStopped = true;
    highlight.hide();
  });
  const changedBuffer = term.buffer.onBufferChange(() => {
    release();
    stopQueuedReports();
    remote = null;
    stopTimer();
    frameChanged = false;
    captureStopped = true;
    renderedFrame = [];
    highlight.hide();
  });
  host.addEventListener("mousedown", onDown, true);
  host.addEventListener("wheel", onWheel, { capture: true, passive: false });
  host.addEventListener("copy", onCopy, true);
  host.addEventListener("contextmenu", onContextMenu, true);
  host.addEventListener("keydown", onKey, true);
  doc.addEventListener("mousemove", onMove, true);
  doc.addEventListener("mouseup", onUp, true);
  const onBlur = () => { release(); };
  view.addEventListener("blur", onBlur);

  return {
    getText,
    hasSelection,
    clear,
    dispose() {
      release();
      disposed = true;
      stopTimer();
      view.clearTimeout(parseTimer);
      view.clearTimeout(finishTimer);
      highlight.dispose();
      if (contextCopy && term.textarea) term.textarea.value = "";
      parsed.dispose();
      syncStart.dispose();
      syncEnd.dispose();
      repaintStart.dispose();
      selection.dispose();
      rendered.dispose();
      resized.dispose();
      changedBuffer.dispose();
      host.removeEventListener("mousedown", onDown, true);
      host.removeEventListener("wheel", onWheel, true);
      host.removeEventListener("copy", onCopy, true);
      host.removeEventListener("contextmenu", onContextMenu, true);
      host.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("mousemove", onMove, true);
      doc.removeEventListener("mouseup", onUp, true);
      view.removeEventListener("blur", onBlur);
    },
  };
}
