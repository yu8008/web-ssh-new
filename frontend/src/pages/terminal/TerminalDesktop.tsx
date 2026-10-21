import React from "react";
import { Copy } from "lucide-react";
import { Button } from "../../components/Button";
import type { TerminalSessionState } from "./useTerminalSession";

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
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const { selectionText, selectionAnchor, handleCopySelection } = state;
  const [copyFlash, setCopyFlash] = React.useState(false);

  React.useEffect(() => {
    setCopyFlash(false);
  }, [selectionText]);

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
    <div className={`flex min-h-screen flex-col transition-colors duration-300 ${state.isDark ? "bg-slate-950 text-slate-100 dark-scrollbar" : "bg-gray-100 text-slate-900 light-scrollbar"}`}>
      <div className={`border-b px-4 py-3 ${state.isDark ? "border-slate-800" : "border-slate-200 bg-white"}`}>
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <div className="flex items-center gap-3">
              <span className={`text-sm font-medium ${state.isDark ? "text-slate-200" : "text-slate-700"}`}>
                {state.sessionInfo?.name || state.t("会话", "Session")} | {state.sessionInfo ? new Date(state.sessionInfo.started_at).toLocaleString() : ""}
              </span>
              <span className={`text-xs ${state.connectionTone}`}>
                {state.reconnectCountdown !== null ? state.t(`重连中 (${state.reconnectCountdown}s)`, `Reconnecting (${state.reconnectCountdown}s)`) : state.connectionLabel}
              </span>
              <span className={`text-xs ${state.networkProfileTone}`}>{state.networkProfileLabel}</span>
              {state.targetLatencyMs !== null ? (
                <div className="flex items-center gap-1">
                  <span className={`text-xs ${state.isDark ? "text-slate-500" : "text-slate-400"}`}>{state.targetLatencyMs}ms</span>
                  <div
                    className={`flex h-4 w-[100px] items-end gap-px rounded px-1 ${state.isDark ? "bg-slate-900/60" : "bg-slate-200/70"}`}
                    title={state.t("近30次网络延迟波动", "Latency trend (last 30 samples)")}
                    aria-label={state.t("近30次网络延迟波动", "Latency trend (last 30 samples)")}
                  >
                    {state.latencyBarHeights.map((height, index) => (
                      <span
                        key={index}
                        className={`flex-1 rounded-sm ${height > 0 ? (state.isDark ? "bg-cyan-400/80" : "bg-cyan-600/80") : "bg-transparent"}`}
                        style={height > 0 ? { height: `${height}px` } : undefined}
                      />
                    ))}
                  </div>
                  {state.latencyHistoryMaxMs !== null ? (
                    <span
                      className={`text-[10px] whitespace-nowrap ${state.isDark ? "text-slate-500" : "text-slate-400"}`}
                      title={state.t("近30次最大延迟", "Max latency in last 30 samples")}
                    >
                      {state.t("最大", "Max")} {state.latencyHistoryMaxMs}ms
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
            {state.sessionInfo?.note ? (
              <span className={`text-xs mt-1 ${state.isDark ? "text-slate-500" : "text-slate-400"}`}>{state.sessionInfo.note}</span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" lightMode={!state.isDark} onClick={state.toggleLanguage}>
              {state.language === "en-US" ? "中文" : "EN"}
            </Button>
            <Button variant="secondary" lightMode={!state.isDark} onClick={onBack}>
              {state.t("返回会话管理", "Back to Sessions")}
            </Button>
            <Button variant="ghost" lightMode={!state.isDark} onClick={state.toggleTheme}>
              {state.isDark ? state.t("浅色", "Light") : state.t("深色", "Dark")}
            </Button>
            <Button variant="ghost" lightMode={!state.isDark} onClick={state.handleClear}>
              {state.t("清屏", "Clear")}
            </Button>
            <Button variant="ghost" lightMode={!state.isDark} onClick={state.handleSelectAll}>
              {state.t("全选", "Select all")}
            </Button>
            {state.connectionState === "closed" && state.reconnectCountdown !== null ? (
              <Button variant="ghost" lightMode={!state.isDark} onClick={state.handleCancelReconnect}>
                {state.t("取消重连", "Cancel reconnect")}
              </Button>
            ) : null}
            {state.connectionState === "closed" && state.reconnectCountdown === null ? (
              <Button variant="secondary" lightMode={!state.isDark} onClick={state.handleReconnect}>
                {state.t("重连", "Reconnect")}
              </Button>
            ) : null}
            <Button variant="secondary" lightMode={!state.isDark} onClick={state.handleCopySelection}>
              {state.t("复制", "Copy")}
            </Button>
          </div>
        </div>
      </div>
      <div ref={containerRef} className="flex flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0">
          <div className="relative flex-1 p-4 min-h-0">
            <div
              ref={state.terminalRef}
              className={`h-full w-full rounded-lg border ${state.isDark ? "border-slate-800" : "border-slate-300 xterm-light"} ${state.sessionInfo?.enhanced_enabled ? "xterm-tmux-enhanced" : ""}`}
              tabIndex={-1}
              onClick={() => state.terminalInstance.current?.focus()}
            />
            {state.selectionText && selectionAnchor ? (
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
        </div>
        <div
          onMouseDown={handleMouseDown}
          className={`w-1 cursor-col-resize transition-colors hidden md:block ${
            isDragging
              ? (state.isDark ? "bg-indigo-500" : "bg-indigo-400")
              : (state.isDark ? "bg-slate-800 hover:bg-slate-700" : "bg-slate-200 hover:bg-slate-300")
          }`}
        />
        <div
          style={{ width: sidebarWidth }}
          className={`hidden min-h-0 flex-shrink-0 flex-col gap-3 overflow-hidden p-3 md:flex ${state.isDark ? "bg-slate-900/50 dark-scrollbar" : "bg-white border-l border-slate-200 light-scrollbar"}`}
        >
          <div className="max-h-[42%] shrink-0 overflow-y-auto pr-1">
            {state.sessionId ? (
              <React.Suspense fallback={<TerminalPanelFallback isDark={state.isDark} />}>
                <SystemMonitor
                  sessionId={state.sessionId}
                  isDark={state.isDark}
                  selectedFilePath={state.selectedFilePath || undefined}
                  networkProfile={state.sessionNetworkProfile}
                />
              </React.Suspense>
            ) : null}
          </div>
          <div className={`flex min-h-0 flex-1 flex-col rounded-lg border p-3 ${state.isDark ? "border-slate-800 bg-slate-950/40" : "border-slate-200 bg-white"}`}>
            {state.sessionId ? (
              <React.Suspense fallback={<TerminalPanelFallback isDark={state.isDark} />}>
                <FileBrowser
                  sessionId={state.sessionId}
                  isDark={state.isDark}
                  currentDir={state.currentDir}
                  onFileSelect={state.setSelectedFilePath}
                  networkProfile={state.sessionNetworkProfile}
                  compact
                />
              </React.Suspense>
            ) : null}
          </div>
        </div>
      </div>
      {isDragging ? <div className="fixed inset-0 z-50 cursor-col-resize" /> : null}
      {state.sessionDisconnected?.disconnected && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950">
          <div className="text-center">
            <div className="text-2xl mb-4 text-rose-400">{state.t("会话已断开", "Session disconnected")}</div>
            <div className="text-sm text-slate-400">{state.t("断开时间", "Disconnected at")}: {state.sessionDisconnected.time}</div>
          </div>
        </div>
      )}
    </div>
  );
}
