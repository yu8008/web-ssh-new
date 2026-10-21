import React from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { clearAuthStorage, getSession, getStoredToken, openTerminalSocket } from "../../lib/api";
import { attachTerminalSelection } from "./terminalSelection";
import { createTerminalInputWriter } from "./terminalInput";
import { configureTerminalRendering } from "./terminalRendering";
import { attachTerminalWheel } from "./terminalWheel";
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
  setCurrentDir: (dir: string) => void;
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
  setCurrentDir,
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

  React.useEffect(() => {
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
      fitAddon.current?.fit();
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

  const announceThemeColors = React.useCallback(
    (isDark: boolean) => {
      themeRef.current = isDark ? "dark" : "light";
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

      if (isReconnect) {
        term.write(`\r\n\x1b[33m${t("正在重新连接...", "Reconnecting...")}\x1b[0m\r\n`);
      }

      const socket = openTerminalSocket(sessionId);
      socketRef.current = socket;
      let sanitizePendingSuffix = "";

      socket.onmessage = (event) => {
        if (socketRef.current !== socket) {
          return;
        }
        const sanitized = sanitizeTerminalOutputChunk(
          String(event.data ?? ""),
          enhancedSessionRef.current,
          sanitizePendingSuffix
        );
        sanitizePendingSuffix = sanitized.pendingSuffix;
        const output = sanitized.output;

        term.write(output);

        // 检测目录变化：解析提示符中的路径
        const text = output.replace(/\x1b\[[0-9;]*m/g, "");
        const promptMatch = text.match(/:([/][^\s$#]+)[\s$#]/);
        if (promptMatch && promptMatch[1] && !promptMatch[1].startsWith("//")) {
          setCurrentDir(promptMatch[1]);
        }
      };

      socket.onopen = () => {
        if (socketRef.current !== socket) {
          return;
        }
        reconnectAttemptRef.current = 0;
        clearNetworkHint();
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
        term.focus();
        if (isReconnect) {
          push(t("重新连接成功", "Reconnected successfully"));
        }
      };

      socket.onerror = () => {
        if (socketRef.current !== socket) {
          return;
        }
        setConnectionState("closed");
        reportNetworkHint("poor", 15000);
      };

      socket.onclose = (event) => {
        if (socketRef.current !== socket) {
          return;
        }
        setConnectionState("closed");
        if (!event.wasClean) {
          reportNetworkHint("poor", 25000);
        }

        if (autoReconnect && !event.wasClean && reconnectAttemptRef.current < 5) {
          const schedule = [2, 4, 8, 16, 32];
          const attempt = reconnectAttemptRef.current + 1;
          const delaySeconds = schedule[attempt - 1] ?? schedule[schedule.length - 1];
          const delay = delaySeconds * 1000;
          reconnectAttemptRef.current = attempt;

          const reconnectMessage = t(
            `连接已断开，${delaySeconds}秒后自动重连 (${reconnectAttemptRef.current}/5)...`,
            `Connection lost. Auto reconnect in ${delaySeconds}s (${reconnectAttemptRef.current}/5)...`
          );
          term.write(`\r\n\x1b[31m${reconnectMessage}\x1b[0m\r\n`);
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
        } else if (!event.wasClean) {
          term.write(`\r\n\x1b[31m${t("连接已断开", "Connection lost")}\x1b[0m\r\n`);
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
      setCurrentDir,
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
    terminalInstance.current?.write(`\r\n\x1b[33m${t("已取消自动重连", "Auto reconnect canceled")}\x1b[0m\r\n`);
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
    const viewport = container.querySelector<HTMLElement>(".xterm-viewport");
    if (viewport) {
      const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const isAtTop = viewport.scrollTop <= 0;
      const isAtBottom = viewport.scrollTop >= maxScrollTop;
      const isEnhancedSession = enhancedSessionRef.current;
      if (isEnhancedSession && lineDelta < 0 && isAtTop) {
        sendTmuxWheelPage(lineDelta);
        return;
      }
      if (isEnhancedSession && lineDelta > 0 && isAtBottom) {
        sendTmuxWheelPage(lineDelta);
        return;
      }
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

    // 会话切换时清空上一个会话遗留的选区状态。
    setHasSelection(false);
    setSelectionAnchor(null);

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
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 15,
        lineHeight: 1.3,
        cursorBlink: true,
        scrollback: 100000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(terminalContainer);
      configureTerminalRendering(term);
      fit.fit();

      terminalInstance.current = term;
      fitAddon.current = fit;

      connectSocketRef.current(term);

      inputWriter = createTerminalInputWriter(window, (data) => { sendInputRef.current(data); });
      term.onData(inputWriter.write);

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
      });
      selectionControllerRef.current = selectionController;

      // 复制快捷键：Windows/Linux 用 Ctrl+Shift+C，macOS 用 Cmd+C。
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") {
          return true;
        }
        const key = event.key.toLowerCase();
        const copyCombo =
          (event.metaKey && !event.ctrlKey && key === "c") ||
          (event.ctrlKey && event.shiftKey && key === "c");
        if (!copyCombo) {
          return true;
        }
        const selection = getSelectionText();
        if (selection) {
          copyRequestRef.current?.(selection);
        }
        // 无论有没有选区都不把 Ctrl/Cmd+Shift+C 当输入发给远端。
        return false;
      });

      wheelController = attachTerminalWheel(term, terminalContainer, () => enhancedSessionRef.current, inputWriter.write);
      handleResize = () => {
        if (!term) {
          return;
        }
        syncTerminalSizeRef.current(term);
      };

      window.addEventListener("resize", handleResize);
    };

    void initTerminal();

    return () => {
      disposed = true;
      wheelController?.dispose();
      if (handleResize) {
        window.removeEventListener("resize", handleResize);
      }
      selectionController?.dispose();
      inputWriter?.dispose();
      if (selectionControllerRef.current === selectionController) selectionControllerRef.current = null;
      clearReconnectTimer();
      socketRef.current?.close();
      term?.dispose();
    };
  }, [sessionId, clearReconnectTimer, enhancedSessionRef, getSelectionText]);

  return {
    terminalRef,
    terminalInstance,
    fitAddon,
    connectionState,
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
    announceThemeColors,
  };
}
