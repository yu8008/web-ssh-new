import React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { clearAuthStorage, getSession, getStoredToken, openTerminalSocket, uploadClipboardImage } from "../../lib/api";
import { attachTerminalSelection } from "./terminalSelection";
import { createTerminalInputWriter } from "./terminalInput";
import { createTerminalLatencyProbe } from "./terminalLatency";
import { createBrowserLagMonitor, type TerminalDiagnostics } from "./terminalDiagnostics";
import { configureTerminalRendering } from "./terminalRendering";
import { createTerminalColors, terminalMinimumContrast } from "./terminalColors";
import { disposeTerminal } from "./terminalLifecycle";
import { attachTerminalWheel } from "./terminalWheel";
import { createTerminalOutput, decodeTerminalOutput, isTerminalOutputProtocol } from "./terminalOutput";
import { attachTerminalViewport } from "./terminalViewport";
import { attachTerminalShortcuts } from "./terminalShortcuts";
import { attachTerminalPaste } from "./terminalPaste";
import { getTerminalScrollback } from "./terminalPreferences";
import {
  buildDefaultColorAnnouncement,
  clampSelectionAnchor,
  darkTerminalTheme,
  lightTerminalTheme,
  sanitizeTerminalOutputChunk,
} from "./terminalUtils";

type TerminalSocketOptions = {
  sessionId?: string;
  t: (zh: string, en: string) => string;
  push: (message: string) => void;
  reportNetworkHint: (profile: "degraded" | "poor", durationMs: number) => void;
  clearNetworkHint: () => void;
  enhancedSessionRef: React.MutableRefObject<boolean>;
  /** 用户在终端里触发了复制快捷键时的回调（Ctrl/Cmd+Shift+C 等）。 */
  onCopyRequest?: (text: string) => void;
};

type ResizeState = { socket: WebSocket; rows: number; cols: number };

export function useTerminalSocket({
  sessionId,
  t,
  push,
  reportNetworkHint,
  clearNetworkHint,
  enhancedSessionRef,
  onCopyRequest,
}: TerminalSocketOptions) {
  const terminalRef = React.useRef<HTMLDivElement | null>(null);
  const terminalInstance = React.useRef<Terminal | null>(null);
  const fitAddon = React.useRef<FitAddon | null>(null);
  const socketRef = React.useRef<WebSocket | null>(null);
  const reconnectTimerRef = React.useRef<number | null>(null);
  const reconnectCountdownIntervalRef = React.useRef<number | null>(null);
  const reconnectAttemptRef = React.useRef(0);
  const lastResizeStateRef = React.useRef<ResizeState | null>(null);
  const selectionControllerRef = React.useRef<ReturnType<typeof attachTerminalSelection> | null>(null);
  const outputRef = React.useRef<ReturnType<typeof createTerminalOutput> | null>(null);
  const colorsRef = React.useRef<ReturnType<typeof createTerminalColors> | null>(null);
  const viewportRef = React.useRef<ReturnType<typeof attachTerminalViewport> | null>(null);
  const latencyProbeRef = React.useRef<ReturnType<typeof createTerminalLatencyProbe> | null>(null);
  const browserLagRef = React.useRef<ReturnType<typeof createBrowserLagMonitor> | null>(null);
  const [terminalLatencyMs, setTerminalLatencyMs] = React.useState<number | null>(null);
  const [terminalDiagnostics, setTerminalDiagnostics] = React.useState<TerminalDiagnostics | null>(null);
  const replayingRef = React.useRef(false);
  const remotePaintRef = React.useRef(false);
  const paintedRef = React.useRef(false);
  const [hasRenderedOutput, setHasRenderedOutput] = React.useState(false);
  const [connectionState, setConnectionState] = React.useState<"connecting" | "open" | "closed">("connecting");
  const [autoReconnect, setAutoReconnect] = React.useState(true);
  const [reconnectCountdown, setReconnectCountdown] = React.useState<number | null>(null);
  const [hasSelection, setHasSelection] = React.useState(false);
  // 选区结束位置（相对终端容器），用于把“选中即复制”的气泡贴在鼠标附近。
  const [selectionAnchor, setSelectionAnchor] = React.useState<{ x: number; y: number } | null>(null);
  const themeRef = React.useRef<"dark" | "light">(
    typeof window !== "undefined" && localStorage.getItem("theme") === "light" ? "light" : "dark"
  );
  const copyRequestRef = React.useRef(onCopyRequest);
  const selectionLimitRef = React.useRef(() => {});
  const pasteFeedbackRef = React.useRef({ t, push });

  React.useEffect(() => {
    pasteFeedbackRef.current = { t, push };
    copyRequestRef.current = onCopyRequest;
    selectionLimitRef.current = () => push(t("选中内容已达上限，请分段复制", "Selection limit reached. Copy in smaller sections."));
  }, [onCopyRequest, push, t]);

  const clearReconnectTimer = React.useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (reconnectCountdownIntervalRef.current) {
      clearInterval(reconnectCountdownIntervalRef.current);
      reconnectCountdownIntervalRef.current = null;
    }
    setReconnectCountdown(null);
  }, []);

  const sendResize = React.useCallback((term: Terminal, options?: { force?: boolean }) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    const { rows, cols } = term;
    const lastResize = lastResizeStateRef.current;
    if (
      !options?.force &&
      lastResize &&
      lastResize.socket === socket &&
      lastResize.rows === rows &&
      lastResize.cols === cols
    ) {
      return false;
    }
    socket.send(JSON.stringify({ type: "resize", rows, cols }));
    lastResizeStateRef.current = { socket, rows, cols };
    return true;
  }, []);

  const syncTerminalSize = React.useCallback(
    (term: Terminal, options?: { force?: boolean }) => {
      const viewport = viewportRef.current;
      const snapshot = viewport?.capture();
      fitAddon.current?.fit();
      viewport?.restore(snapshot);
      sendResize(term, options);
    },
    [sendResize]
  );

  const sendInput = React.useCallback(
    (data: string, notifyOnError: boolean = false) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (notifyOnError) {
          push(t("终端未连接", "Terminal is not connected"));
        }
        return false;
      }
      socket.send(JSON.stringify({ type: "input", data }));
      return true;
    },
    [push, t]
  );

  /**
   * 把当前主题的默认前景/背景色作为颜色应答送回会话。
   *
   * 走 tmux 的增强会话里，TUI（如 Codex）的 OSC 10/11 查询由 tmux 代答，
   * 而 tmux 缓存的是它启动时从浏览器终端拿到的配色。主题切换后不刷新缓存，
   * TUI 就会按旧配色（常见是浅色）绘制输入框，在深色终端里出现白色条带。
   * 这里主动补发一次应答，让 tmux 的缓存与界面保持一致。
   */
  const sendThemeAnnouncement = React.useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (!enhancedSessionRef.current) {
      return;
    }
    const theme = themeRef.current === "light" ? lightTerminalTheme : darkTerminalTheme;
    const payload = buildDefaultColorAnnouncement(theme);
    if (payload) {
      socket.send(JSON.stringify({ type: "input", data: payload }));
    }
  }, [enhancedSessionRef]);

  const setTerminalTheme = React.useCallback(
    (isDark: boolean) => {
      themeRef.current = isDark ? "dark" : "light";
      colorsRef.current?.setTheme(isDark);
      sendThemeAnnouncement();
    },
    [sendThemeAnnouncement]
  );

  const connectSocket = React.useCallback(
    (term: Terminal, isReconnect: boolean = false) => {
      if (!sessionId) {
        return;
      }
      const token = getStoredToken();
      if (!token) {
        clearAuthStorage();
        window.location.href = "/";
        return;
      }

      clearReconnectTimer();
      setConnectionState("connecting");
      remotePaintRef.current = false;
      paintedRef.current = false;
      setHasRenderedOutput(false);
      const outputWriter = outputRef.current;
      if (!outputWriter) return;

      if (isReconnect) {
        outputWriter.enqueue(`\r\n\x1b[33m${t("正在重新连接...", "Reconnecting...")}\x1b[0m\r\n`);
      }

      const socket = openTerminalSocket(sessionId);
      socketRef.current = socket;
      latencyProbeRef.current?.dispose();
      latencyProbeRef.current = null;
      setTerminalLatencyMs(null);
      setTerminalDiagnostics(null);
      let latencyProbe: ReturnType<typeof createTerminalLatencyProbe> | undefined;
      const stopLatencyProbe = () => {
        latencyProbe?.dispose();
        if (latencyProbeRef.current === latencyProbe) latencyProbeRef.current = null;
      };
      let sanitizePendingSuffix = "";
      let lastQueuedSeq = 0;
      let pendingAck: { seq: number; epoch: string } | null = null;
      let ackScheduled = false;
      const acknowledge = (seq: number, epoch: string) => {
        if (socketRef.current !== socket) return;
        pendingAck = { seq, epoch };
        if (ackScheduled) return;
        ackScheduled = true;
        queueMicrotask(() => {
          ackScheduled = false;
          if (pendingAck && socketRef.current === socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "ack", ack_seq: pendingAck.seq, epoch: pendingAck.epoch }));
          }
          pendingAck = null;
        });
      };
      const resetReplay = () => {
        sanitizePendingSuffix = "";
        lastQueuedSeq = 0;
        replayingRef.current = true;
        outputWriter.replacePending(() => {
          selectionControllerRef.current?.clear();
          colorsRef.current?.reset();
          term.reset();
          remotePaintRef.current = false;
          paintedRef.current = false;
          setHasRenderedOutput(false);
        });
      };

      socket.onmessage = (event) => {
        if (socketRef.current !== socket) {
          return;
        }
        let data = String(event.data ?? "");
        let parsedAck: (() => void) | undefined;
        if (isTerminalOutputProtocol(socket.protocol)) {
          const frame = decodeTerminalOutput(data);
          if (frame?.type === "pong") {
            const roundTripMs = latencyProbe?.pong(frame.ping_id);
            if (roundTripMs !== null && roundTripMs !== undefined) {
              const output = outputWriter.diagnostics();
              setTerminalDiagnostics({ roundTripMs, gatewayQueueMs: frame.gateway_queue_ms, gatewayLagMs: frame.gateway_loop_lag_ms,
                gatewayQueuedChars: frame.gateway_queued_chars, gatewayInflightChars: frame.gateway_inflight_chars,
                browserLagMs: browserLagRef.current?.maximumMs() ?? 0, renderWaitMs: browserLagRef.current?.renderWaitMs(), outputWaitMs: Math.round(output.waitMs),
                outputParseMs: Math.round(output.parseMs), outputQueuedChars: output.queuedChars });
            }
            return;
          }
          if (frame?.type === "replay_start") { resetReplay(); return; }
          if (frame?.type === "replay_end") {
            // The enable sequence may have aged out of the bounded history.
            // Restore parser state after replay, before any later live output;
            // this is local output, never a command sent to the remote CLI.
            const pasteMode = typeof frame.bracketed_paste === "boolean"
              ? `\x1b[?2004${frame.bracketed_paste ? "h" : "l"}` : "";
            outputWriter.enqueue(pasteMode, () => { replayingRef.current = false; });
            return;
          }
          if (frame?.type === "output") {
            if (frame.seq <= lastQueuedSeq) return;
            lastQueuedSeq = frame.seq;
            data = frame.data;
            if (frame.epoch) { const epoch = frame.epoch; parsedAck = () => acknowledge(frame.seq, epoch); }
          }
        }
        const sanitized = sanitizeTerminalOutputChunk(
          data,
          enhancedSessionRef.current,
          sanitizePendingSuffix
        );
        sanitizePendingSuffix = sanitized.pendingSuffix;
        const output = sanitized.output;

        outputWriter.enqueue(output, () => { remotePaintRef.current = true; parsedAck?.(); });
      };

      socket.onopen = () => {
        if (socketRef.current !== socket) {
          return;
        }
        reconnectAttemptRef.current = 0;
        if (!isTerminalOutputProtocol(socket.protocol)) {
          replayingRef.current = false;
          if (isReconnect) resetReplay();
          replayingRef.current = false;
        }
        clearNetworkHint();
        if (isTerminalOutputProtocol(socket.protocol)) {
          socket.send(JSON.stringify({ type: "flow_control" }));
          latencyProbe = createTerminalLatencyProbe(window,
            (pingId) => socket.send(JSON.stringify({ type: "ping", ping_id: pingId, diagnostics: true })),
            (milliseconds) => {
              if (socketRef.current === socket) {
                setTerminalLatencyMs(milliseconds);
                if (milliseconds === null) setTerminalDiagnostics(null);
              }
            });
          latencyProbeRef.current = latencyProbe;
        }
        syncTerminalSize(term, { force: true });
        sendThemeAnnouncement();
        [300, 1200].forEach((delay) => {
          window.setTimeout(() => {
            if (socketRef.current === socket && socket.readyState === WebSocket.OPEN) {
              syncTerminalSize(term);
            }
          }, delay);
        });
        setConnectionState("open");
        const focused = term.element?.ownerDocument.activeElement;
        const editingOutside = focused instanceof HTMLElement && !term.element?.contains(focused)
          && (focused.matches("input, textarea") || focused.isContentEditable || focused.closest('[role="dialog"]'));
        if (!editingOutside) term.focus();
        if (isReconnect) {
          push(t("重新连接成功", "Reconnected successfully"));
        }
      };

      socket.onerror = () => {
        stopLatencyProbe();
        if (socketRef.current !== socket) {
          return;
        }
        setConnectionState("closed");
        setTerminalLatencyMs(null);
        setTerminalDiagnostics(null);
        reportNetworkHint("poor", 15000);
      };

      socket.onclose = (event) => {
        stopLatencyProbe();
        if (socketRef.current !== socket) {
          return;
        }
        setConnectionState("closed");
        setTerminalLatencyMs(null);
        setTerminalDiagnostics(null);
        if (!event.wasClean) {
          reportNetworkHint("poor", 25000);
        }

        const retryable = !event.wasClean || [1011, 1012, 1013, 4001].includes(event.code);
        if (autoReconnect && retryable && reconnectAttemptRef.current < 5) {
          const schedule = [2, 4, 8, 16, 32];
          const attempt = reconnectAttemptRef.current + 1;
          const delaySeconds = schedule[attempt - 1] ?? schedule[schedule.length - 1];
          const delay = delaySeconds * 1000;
          reconnectAttemptRef.current = attempt;

          const reconnectMessage = t(
            `连接已断开，${delaySeconds}秒后自动重连 (${reconnectAttemptRef.current}/5)...`,
            `Connection lost. Auto reconnect in ${delaySeconds}s (${reconnectAttemptRef.current}/5)...`
          );
          outputWriter.enqueue(`\r\n\x1b[31m${reconnectMessage}\x1b[0m\r\n`);
          setReconnectCountdown(Math.round(delay / 1000));

          let countdown = Math.round(delay / 1000);
          if (reconnectCountdownIntervalRef.current) {
            clearInterval(reconnectCountdownIntervalRef.current);
            reconnectCountdownIntervalRef.current = null;
          }
          reconnectCountdownIntervalRef.current = window.setInterval(() => {
            countdown -= 1;
            if (countdown > 0) {
              setReconnectCountdown(countdown);
            } else if (reconnectCountdownIntervalRef.current) {
              clearInterval(reconnectCountdownIntervalRef.current);
              reconnectCountdownIntervalRef.current = null;
            }
          }, 1000);

          reconnectTimerRef.current = window.setTimeout(() => {
            if (reconnectCountdownIntervalRef.current) {
              clearInterval(reconnectCountdownIntervalRef.current);
              reconnectCountdownIntervalRef.current = null;
            }
            connectSocket(term, true);
          }, delay);
        } else if (retryable) {
          outputWriter.enqueue(`\r\n\x1b[31m${t("连接已断开", "Connection lost")}\x1b[0m\r\n`);
          push(t("终端连接已断开", "Terminal connection closed"));
        }
      };
    },
    [
      sessionId,
      clearReconnectTimer,
      t,
      syncTerminalSize,
      sendThemeAnnouncement,
      push,
      reportNetworkHint,
      clearNetworkHint,
      autoReconnect,
      enhancedSessionRef,
    ]
  );

  const handleReconnect = React.useCallback(() => {
    const term = terminalInstance.current;
    if (!term) {
      return;
    }
    reconnectAttemptRef.current = 0;
    socketRef.current?.close();
    connectSocket(term, true);
  }, [connectSocket]);

  const handleCancelReconnect = React.useCallback(() => {
    clearReconnectTimer();
    setAutoReconnect(false);
    outputRef.current?.enqueue(`\r\n\x1b[33m${t("已取消自动重连", "Auto reconnect canceled")}\x1b[0m\r\n`);
  }, [clearReconnectTimer, t]);

  const connectSocketRef = React.useRef(connectSocket);
  const sendInputRef = React.useRef(sendInput);
  const syncTerminalSizeRef = React.useRef(syncTerminalSize);
  const getSelectionText = React.useCallback(() =>
    selectionControllerRef.current?.getText() ?? terminalInstance.current?.getSelection() ?? "", []);
  const clearSelectionSnapshot = React.useCallback(() => selectionControllerRef.current?.clear(), []);
  const scrollTerminal = React.useCallback((direction: "up" | "down", mode: "auto" | "remote" = "auto") => {
    const term = terminalInstance.current;
    const container = terminalRef.current;
    if (!term || !container) {
      return;
    }
    const lineDelta = direction === "up" ? -8 : 8;
    viewportRef.current?.interact();
    const sendTmuxWheelPage = (delta: number) => {
      if (delta === 0) {
        return;
      }
      const sequence = delta < 0 ? "\x1b[5~" : "\x1b[6~";
      sendInput(sequence);
    };
    const sendTmuxMouseWheel = (delta: number) => {
      if (delta === 0) {
        return;
      }
      const col = Math.max(1, Math.floor(term.cols / 2));
      const row = Math.max(1, Math.floor(term.rows / 2));
      const code = delta < 0 ? 64 : 65;
      sendInput(`\x1b[<${code};${col};${row}M`);
    };
    if (mode === "remote") {
      if (enhancedSessionRef.current && term.modes.mouseTrackingMode !== "none") {
        sendTmuxMouseWheel(lineDelta);
        return;
      }
      if (enhancedSessionRef.current) {
        term.scrollLines(lineDelta);
        return;
      }
      term.scrollLines(lineDelta);
      return;
    }
    const activeBuffer = term.buffer.active;
    const hasLocalScrollback = activeBuffer.type === "normal" && activeBuffer.baseY > 0;
    if (!hasLocalScrollback) {
      sendTmuxWheelPage(lineDelta);
      return;
    }
    const isAtTop = activeBuffer.viewportY <= 0;
    const isAtBottom = activeBuffer.viewportY >= activeBuffer.baseY;
    const isEnhancedSession = enhancedSessionRef.current;
    if (isEnhancedSession && lineDelta < 0 && isAtTop) {
      sendTmuxWheelPage(lineDelta);
      return;
    }
    if (isEnhancedSession && lineDelta > 0 && isAtBottom) {
      sendTmuxWheelPage(lineDelta);
      return;
    }
    term.scrollLines(lineDelta);
  }, [sendInput, enhancedSessionRef]);

  React.useEffect(() => {
    connectSocketRef.current = connectSocket;
    sendInputRef.current = sendInput;
    syncTerminalSizeRef.current = syncTerminalSize;
  }, [connectSocket, sendInput, syncTerminalSize]);

  React.useEffect(() => {
    const terminalContainer = terminalRef.current;
    if (!terminalContainer || !sessionId) {
      return;
    }
    let disposed = false;
    let term: Terminal | null = null;
    let wheelController: ReturnType<typeof attachTerminalWheel> | null = null;
    let handleResize: (() => void) | null = null;
    let selectionController: ReturnType<typeof attachTerminalSelection> | null = null;
    let inputWriter: ReturnType<typeof createTerminalInputWriter> | null = null;
    let outputWriter: ReturnType<typeof createTerminalOutput> | null = null;
    let viewport: ReturnType<typeof attachTerminalViewport> | null = null;
    let rendered: { dispose(): void } | null = null;
    let rendering: ReturnType<typeof configureTerminalRendering> | null = null;
    let colors: ReturnType<typeof createTerminalColors> | null = null;
    let pasteController: ReturnType<typeof attachTerminalPaste> | null = null;
    let shortcuts: ReturnType<typeof attachTerminalShortcuts> | null = null;
    let resizeObserver: ResizeObserver | null = null;

    // 会话切换时清空上一个会话遗留的选区状态。
    setHasSelection(false);
    setSelectionAnchor(null);
    setHasRenderedOutput(false);

    const initTerminal = async () => {
      try {
        const session = await getSession(sessionId);
        if (!disposed) {
          enhancedSessionRef.current = session.enhanced_enabled === true;
        }
      } catch {
        // 忽略初始化会话信息失败
      }

      if (disposed) {
        return;
      }

      const initialTheme = themeRef.current;

      term = new Terminal({
        theme: initialTheme === "light" ? lightTerminalTheme : darkTerminalTheme,
        minimumContrastRatio: terminalMinimumContrast(initialTheme !== "light"),
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 15,
        lineHeight: 1.3,
        cursorBlink: true,
        scrollback: getTerminalScrollback(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(terminalContainer);
      rendering = configureTerminalRendering(term);
      fit.fit();

      terminalInstance.current = term;
      fitAddon.current = fit;
      colors = createTerminalColors(term);
      colorsRef.current = colors;

      viewport = attachTerminalViewport(term, terminalContainer);
      viewportRef.current = viewport;
      browserLagRef.current = createBrowserLagMonitor(window);
      const activeTerm = term;
      outputWriter = createTerminalOutput({
        write: colors.write,
        beforeWrite: viewport.capture,
        afterWrite: (snapshot) => { viewport?.restore(snapshot); browserLagRef.current?.parsed(); },
        inputPending: () => (navigator as Navigator & { scheduling?: { isInputPending(): boolean } }).scheduling?.isInputPending() ?? false,
        onOverflow: () => {
          // Reconnect through a fresh bounded replay instead of dropping ANSI.
          socketRef.current?.close(4001, "Terminal output queue full");
        },
      });
      outputRef.current = outputWriter;
      rendered = term.onRender(({ start, end }) => {
        browserLagRef.current?.rendered();
        if (!remotePaintRef.current || paintedRef.current) return;
        const buffer = activeTerm.buffer.active;
        for (let row = start; row <= end; row++) {
          if (buffer.getLine(buffer.viewportY + row)?.translateToString(true).trim()) {
            paintedRef.current = true;
            setHasRenderedOutput(true);
            break;
          }
        }
      });

      inputWriter = createTerminalInputWriter(window, (data) => { sendInputRef.current(data); });
      term.onData((data) => {
        // Replayed device/color/cursor queries must not inject replies into the
        // remote prompt. Real keystrokes remain usable while history loads.
        if (replayingRef.current && /^\x1b(?:\[[?=>\d;]*(?:[cnR]|\$y)|\]\d+;[^]*?(?:\x07|\x1b\\))$/.test(data)) return;
        inputWriter!.write(data);
      });

      selectionController = attachTerminalSelection(term, terminalContainer, {
        onChange: (selected) => {
          setHasSelection(selected);
          if (!selected) setSelectionAnchor(null);
        },
        onFinish: (clientX, clientY) => {
          const rect = terminalContainer.getBoundingClientRect();
          setSelectionAnchor(clampSelectionAnchor(clientX - rect.left, clientY - rect.top, {
            width: rect.width, height: rect.height,
          }));
        },
        onLimit: () => selectionLimitRef.current(),
        flushInput: () => inputWriter?.flush(),
      });
      selectionControllerRef.current = selectionController;

      pasteController = attachTerminalPaste(term, terminalContainer, {
        connection: () => socketRef.current?.readyState === WebSocket.OPEN ? socketRef.current : null,
        upload: (file, signal) => uploadClipboardImage(sessionId, file, signal),
        onPaste: () => selectionController?.clear(),
        onUploading: () => {
          const { t, push } = pasteFeedbackRef.current;
          push(t("图片上传中，请稍候…", "Uploading clipboard image, please wait…"));
        },
        onUploaded: (count) => {
          const { t, push } = pasteFeedbackRef.current;
          push(t(`已粘贴 ${count} 张图片`, `Pasted ${count} image(s)`));
        },
        onError: (error) => {
          const { t, push } = pasteFeedbackRef.current;
          const message = error.name === "AbortError"
            ? t("图片上传已超时或取消，请重试", "Image upload timed out or was canceled. Try again.")
            : error.message === "Terminal is not connected"
            ? t("终端未连接", "Terminal is not connected")
            : error.message === "Terminal connection changed; paste again"
            ? t("终端连接已变化，请重新粘贴", "Terminal connection changed; paste again")
            : error.message === "Clipboard image exceeds 20 MiB"
            ? t("剪贴板图片不能超过 20 MiB", "Clipboard image exceeds 20 MiB")
            : error.message;
          push(t("粘贴失败：", "Paste failed: ") + message);
        },
      });

      shortcuts = attachTerminalShortcuts(term, getSelectionText, (text) => copyRequestRef.current?.(text));

      wheelController = attachTerminalWheel(term, terminalContainer, () => enhancedSessionRef.current, inputWriter.write, inputWriter.flush);
      handleResize = () => {
        if (!term) {
          return;
        }
        syncTerminalSizeRef.current(term);
      };

      window.addEventListener("resize", handleResize);
      resizeObserver = new ResizeObserver(() => {
        if (!disposed) handleResize?.();
      });
      resizeObserver.observe(terminalContainer);
      connectSocketRef.current(term);
    };

    void initTerminal();

    return () => {
      disposed = true;
      wheelController?.dispose();
      shortcuts?.dispose();
      if (handleResize) {
        window.removeEventListener("resize", handleResize);
      }
      selectionController?.dispose();
      pasteController?.dispose();
      resizeObserver?.disconnect();
      browserLagRef.current?.dispose();
      browserLagRef.current = null;
      inputWriter?.dispose();
      outputWriter?.dispose();
      colors?.dispose();
      viewport?.dispose();
      rendered?.dispose();
      if (outputRef.current === outputWriter) outputRef.current = null;
      if (colorsRef.current === colors) colorsRef.current = null;
      if (viewportRef.current === viewport) viewportRef.current = null;
      if (selectionControllerRef.current === selectionController) selectionControllerRef.current = null;
      clearReconnectTimer();
      latencyProbeRef.current?.dispose();
      latencyProbeRef.current = null;
      socketRef.current?.close();
      socketRef.current = null;
      if (term) disposeTerminal(term, rendering);
      if (terminalInstance.current === term) terminalInstance.current = null;
    };
  }, [sessionId, clearReconnectTimer, enhancedSessionRef, getSelectionText]);

  return {
    terminalRef,
    terminalInstance,
    fitAddon,
    connectionState,
    terminalLatencyMs,
    terminalDiagnostics,
    hasRenderedOutput,
    reconnectCountdown,
    autoReconnect,
    setAutoReconnect,
    syncTerminalSize,
    scrollTerminal,
    handleReconnect,
    handleCancelReconnect,
    hasSelection,
    getSelectionText,
    clearSelectionSnapshot,
    selectionAnchor,
    setTerminalTheme,
  };
}
