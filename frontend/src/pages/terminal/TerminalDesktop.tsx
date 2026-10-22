import React from "react";
import { ArrowLeft, Copy, Folder, Moon, RefreshCw, Sun, X } from "lucide-react";
import { Button } from "../../components/Button";
import { FileViewer } from "../../components/FileViewer";
import { getServerClock, type ServerClock } from "../../lib/api";
import type { FileInfo } from "../../lib/api";
import type { TerminalSessionState } from "./useTerminalSession";
import { TerminalLoading } from "./TerminalLoading";
import { TerminalComposer } from "./TerminalComposer";
import { TerminalLatencyStatus } from "./TerminalLatencyStatus";

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

const FileBrowser = React.lazy(() =>
  import("../../components/FileBrowser").then((module) => ({ default: module.FileBrowser }))
);
const SystemMonitor = React.lazy(() =>
  import("../../components/SystemMonitor").then((module) => ({ default: module.SystemMonitor }))
);

type TerminalDesktopProps = {
  state: TerminalSessionState;
  onBack: () => void;
};

function clampZoneLabel(clock: ServerClock): string {
  const name = clock.zone_name || clock.zone || "";
  return name.length > 18 ? name.slice(0, 18) + "…" : name;
}

function parseUtcOffset(offset: string): number {
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(offset.trim());
  if (!match) {
    return 0;
  }
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function formatServerTime(ms: number, offsetMinutes: number): string {
  const shifted = new Date(ms + offsetMinutes * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return pad(shifted.getUTCHours()) + ":" + pad(shifted.getUTCMinutes()) + ":" + pad(shifted.getUTCSeconds());
}

function useServerClock(sessionId?: string) {
  const [clock, setClock] = React.useState<ServerClock | null>(null);
  const [skewMs, setSkewMs] = React.useState(0);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!sessionId) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const startedAt = Date.now();
        const data = await getServerClock(sessionId);
        if (cancelled) {
          return;
        }
        setClock(data);
        const roundTrip = Date.now() - startedAt;
        setSkewMs(data.epoch * 1000 + roundTrip / 2 - Date.now());
      } catch {
        // 时钟是辅助信息，读取失败时保持占位
      }
    };
    void load();
    const poll = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, [sessionId]);

  React.useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  return { clock, serverMs: now + skewMs };
}

function TerminalPanelFallback({ isDark }: { isDark: boolean }) {
  return (
    <div className={`flex h-full min-h-[120px] items-center justify-center rounded-lg border text-sm ${isDark ? "border-slate-800 bg-slate-900/40 text-slate-400" : "border-slate-200 bg-white text-slate-500"}`}>
      加载中... / Loading...
    </div>
  );
}

export function TerminalDesktop({ state, onBack }: TerminalDesktopProps) {
  const { syncTerminalSize, terminalInstance } = state;
  const [sidebarWidth, setSidebarWidth] = React.useState(() => {
    const saved = Number(localStorage.getItem("terminal-sidebar-width"));
    // 侧边栏现在同时承载系统状态和文件管理，太窄会挤成一团。
    return Number.isFinite(saved) && saved > 0 ? Math.max(320, saved) : 380;
  });
  const [isDragging, setIsDragging] = React.useState(false);
  const [filesOpen, setFilesOpen] = React.useState(false);
  const { clock, serverMs } = useServerClock(state.sessionId);
  const [openedFile, setOpenedFile] = React.useState<FileInfo | null>(null);
  const closeViewer = React.useCallback(() => setOpenedFile(null), []);

  React.useEffect(() => {
    if (!filesOpen) {
      return;
    }
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFilesOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [filesOpen]);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const { hasSelection, selectionAnchor, handleCopySelection } = state;
  const [copyFlash, setCopyFlash] = React.useState(false);

  React.useEffect(() => {
    setCopyFlash(false);
  }, [hasSelection, selectionAnchor]);

  const handleBubbleCopy = React.useCallback(async () => {
    const copied = await handleCopySelection();
    if (copied) {
      setCopyFlash(true);
      window.setTimeout(() => setCopyFlash(false), 1500);
    }
  }, [handleCopySelection]);

  const handleMouseDown = React.useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  React.useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (event: MouseEvent) => {
      if (!containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const newWidth = containerRect.right - event.clientX;
      const maxWidth = containerRect.width * 0.7;
      const clampedWidth = Math.max(320, Math.min(maxWidth, newWidth));
      setSidebarWidth(clampedWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  React.useEffect(() => {
    localStorage.setItem("terminal-sidebar-width", String(sidebarWidth));
    const timer = window.setTimeout(() => {
      const term = terminalInstance.current;
      if (term) {
        syncTerminalSize(term);
      }
    }, 10);
    return () => clearTimeout(timer);
  }, [sidebarWidth, syncTerminalSize, terminalInstance]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas text-ink transition-colors duration-300 supports-[height:100dvh]:h-dvh">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-chrome px-3 sm:px-4">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label={state.t("返回会话管理", "Back")} title={state.t("返回会话管理", "Back")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{state.sessionInfo?.name || state.t("会话", "Session")}</span>
          <span
            className={cx(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium",
              state.connectionState === "open"
                ? "border-ok/30 bg-ok/10 text-ok"
                : state.connectionState === "connecting"
                  ? "border-warn/30 bg-warn/10 text-warn"
                  : "border-danger/30 bg-danger/10 text-danger"
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {state.reconnectCountdown !== null
              ? state.t("重连中 " + state.reconnectCountdown + "s", "Reconnecting " + state.reconnectCountdown + "s")
              : state.connectionLabel}
          </span>
          {state.sessionInfo?.enhanced_enabled ? (
            <span className="hidden rounded border border-brand/25 bg-brand/8 px-1.5 py-px text-[10px] font-medium text-brand sm:inline">
              {state.t("持久", "Persistent")}
            </span>
          ) : null}
        </div>
        <div className="hidden min-w-0 items-center gap-2 text-2xs text-muted md:flex">
          <span className="font-mono">{state.sessionInfo ? new Date(state.sessionInfo.started_at).toLocaleString() : ""}</span>
          <span aria-hidden="true">·</span>
          <span>{state.networkProfileLabel}</span>
          <TerminalLatencyStatus {...state} />
        </div>
        <div className="ml-auto flex items-center gap-1">
          {state.targetLatencyMs !== null ? (
            <div
              className="mr-1 hidden h-5 w-[84px] items-end gap-px rounded bg-elevated px-1 py-1 lg:flex"
              title={state.t("近30次 SSH 命令延迟波动", "SSH command latency trend (last 30 samples)")}
              aria-label={state.t("近30次 SSH 命令延迟波动", "SSH command latency trend (last 30 samples)")}
            >
              {state.latencyBarHeights.map((height, index) => (
                <span
                  key={index}
                  className={cx("flex-1 rounded-sm", height > 0 ? "bg-brand/70" : "bg-transparent")}
                  style={height > 0 ? { height: Math.max(2, height) + "px" } : undefined}
                />
              ))}
            </div>
          ) : null}
          {state.connectionState === "closed" && state.reconnectCountdown !== null ? (
            <Button variant="ghost" size="sm" onClick={state.handleCancelReconnect}>
              {state.t("取消重连", "Cancel")}
            </Button>
          ) : null}
          {state.connectionState === "closed" && state.reconnectCountdown === null ? (
            <Button variant="secondary" size="sm" onClick={state.handleReconnect}>
              <RefreshCw className="h-3.5 w-3.5" />
              {state.t("重连", "Reconnect")}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={state.handleSelectAll} title={state.t("全选", "Select all")}>
            {state.t("全选", "Select all")}
          </Button>
          <Button variant="ghost" size="sm" onClick={state.handleClear} title={state.t("清屏", "Clear")}>
            {state.t("清屏", "Clear")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void state.handleCopySelection()}>
            <Copy className="h-3.5 w-3.5" />
            {state.t("复制", "Copy")}
          </Button>
          <Button variant="ghost" size="icon" onClick={state.toggleTheme} aria-label={state.t("切换主题", "Toggle theme")} title={state.t("切换主题", "Toggle theme")}>
            {state.isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={state.toggleLanguage} className="hidden sm:inline-flex">
            {state.language === "en-US" ? "中" : "EN"}
          </Button>
        </div>
      </header>
      <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0">
          <div className="relative min-h-0 flex-1 p-3 sm:p-4">
            <div
              className="h-full w-full overflow-hidden rounded-lg border border-line"
              style={{ backgroundColor: state.isDark ? "#020617" : "#ffffff" }}
            >
              <div className={cx("h-full w-full p-3", !state.isDark && "xterm-light", !state.isDark && "xterm-light", state.sessionInfo?.enhanced_enabled && "xterm-tmux-enhanced")}>
                <div
                  ref={state.terminalRef}
                  className="h-full w-full"
                  title={state.t("拖动选择文本，拖到边缘自动滚动；选中后按 Ctrl+C 或 Cmd+C 复制", "Drag to select; edges auto-scroll. Ctrl+C or Cmd+C copies selected text")}
                  tabIndex={-1}
                  onClick={() => state.terminalInstance.current?.focus()}
                />
              </div>
            </div>
            <TerminalLoading state={state} />
            <button
              type="button"
              onClick={() => setFilesOpen((open) => !open)}
              aria-expanded={filesOpen}
              aria-label={state.t("文件", "Files")}
              title={state.t("文件", "Files")}
              className={cx(
                "absolute right-6 top-6 z-20 grid h-8 w-8 place-items-center rounded-md border text-ink-soft shadow-sm backdrop-blur transition",
                filesOpen
                  ? "border-brand/40 bg-brand/12 text-brand"
                  : "border-line bg-surface/90 hover:border-line-strong hover:text-ink"
              )}
            >
              <Folder className="h-4 w-4" />
            </button>

            {filesOpen ? (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setFilesOpen(false)} />
                <div
                  className="animate-pop-in absolute right-6 top-16 z-20 flex h-[min(560px,calc(100%-5rem))] w-[min(430px,calc(100%-3rem))] origin-top-right flex-col overflow-hidden rounded-lg border border-line bg-surface p-3 shadow-panel"
                  role="dialog"
                  aria-label={state.t("文件", "Files")}
                >
                  <button
                    type="button"
                    onClick={() => setFilesOpen(false)}
                    aria-label={state.t("关闭文件面板", "Close files")}
                    className="absolute right-2 top-2 z-10 grid h-6 w-6 place-items-center rounded text-muted transition hover:bg-elevated hover:text-ink"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                  <div className="min-h-0 flex-1 overflow-hidden pt-1">
                    {state.sessionId ? (
                      <React.Suspense fallback={<TerminalPanelFallback isDark={state.isDark} />}>
                        <FileBrowser
                          sessionId={state.sessionId}
                          isDark={state.isDark}
                          currentDir={state.currentDir}
                          onOpenFile={(file) => {
                            setFilesOpen(false);
                            setOpenedFile(file);
                          }}
                          networkProfile={state.sessionNetworkProfile}
                          compact
                        />
                      </React.Suspense>
                    ) : null}
                  </div>
                </div>
              </>
            ) : null}

            {hasSelection && selectionAnchor ? (
              <div
                data-wsg-overlay="true"
                className="absolute z-20"
                style={{
                  left: selectionAnchor.x,
                  top: selectionAnchor.y,
                  transform: "translateX(-50%)",
                }}
              >
                <button
                  type="button"
                  // 阻止按下时抢焦点，否则终端失焦会让选区消失。
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void handleBubbleCopy()}
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium shadow-lg transition ${
                    copyFlash
                      ? "border-emerald-400 bg-emerald-500 text-white"
                      : "border-indigo-400/60 bg-indigo-500 text-white hover:bg-indigo-400"
                  }`}
                  aria-label={state.t("复制选中内容", "Copy selected text")}
                  title={state.t("复制选中内容", "Copy selected text")}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  {copyFlash ? state.t("已复制", "Copied") : state.t("复制", "Copy")}
                </button>
              </div>
            ) : null}
          </div>
          <TerminalComposer key={state.sessionId} connected={state.connectionState === "open"} t={state.t} onFill={state.fillTerminalDraft} />
        </div>
        <div
          onMouseDown={handleMouseDown}
          className={cx(
            "hidden w-1 cursor-col-resize transition-colors md:block",
            isDragging ? "bg-brand/60" : "bg-line hover:bg-line-strong"
          )}
        />
        <div
          style={{ width: sidebarWidth }}
          className="hidden min-h-0 flex-shrink-0 flex-col overflow-hidden border-l border-line bg-chrome p-3 md:flex"
        >
          <div className="mb-2 flex shrink-0 items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2">
            <span className="text-2xs font-medium text-muted">{state.t("服务器时间", "Server time")}</span>
            <span className="flex items-baseline gap-1.5 font-mono text-xs tabular-nums text-ink">
              {clock ? formatServerTime(serverMs, parseUtcOffset(clock.offset)) : "--:--:--"}
              <span className="font-sans text-2xs text-muted">
                {clock ? clampZoneLabel(clock) : state.t("同步中", "syncing")}
              </span>
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {state.sessionId ? (
              <React.Suspense fallback={<TerminalPanelFallback isDark={state.isDark} />}>
                <SystemMonitor
                  sessionId={state.sessionId}
                  isDark={state.isDark}
                  networkProfile={state.sessionNetworkProfile}
                />
              </React.Suspense>
            ) : null}
          </div>
        </div>
      </div>

      {openedFile && state.sessionId ? (
        <FileViewer
          sessionId={state.sessionId}
          path={openedFile.path}
          isDark={state.isDark}
          onClose={closeViewer}
        />
      ) : null}
      {isDragging ? <div className="fixed inset-0 z-50 cursor-col-resize" /> : null}
      {state.sessionDisconnected?.disconnected && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-canvas">
          <div className="text-center">
            <div className="text-2xl mb-4 text-rose-400">{state.t("会话已断开", "Session disconnected")}</div>
            <div className="text-sm text-slate-400">{state.t("断开时间", "Disconnected at")}: {state.sessionDisconnected.time}</div>
          </div>
        </div>
      )}
    </div>
  );
}
