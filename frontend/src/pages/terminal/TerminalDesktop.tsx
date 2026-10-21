import React from "react";
import { Copy, ScanText } from "lucide-react";
import { Button } from "../../components/Button";
import { TerminalCopyPanel } from "./TerminalCopyPanel";
import { createTerminalBufferSnapshot, type TerminalBufferSnapshot } from "./terminalUtils";
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
    const saved = localStorage.getItem("terminal-sidebar-width");
    return saved ? Number(saved) : 256;
  });
  const [isDragging, setIsDragging] = React.useState(false);
  const [copySnapshot, setCopySnapshot] = React.useState<TerminalBufferSnapshot | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const openCopyPanel = React.useCallback(() => {
    const buffer = terminalInstance.current?.buffer.active;
    if (!buffer) {
      return;
    }
    setCopySnapshot(createTerminalBufferSnapshot(buffer));
  }, [terminalInstance]);

  const closeCopyPanel = React.useCallback(() => {
    setCopySnapshot(null);
    window.requestAnimationFrame(() => terminalInstance.current?.focus());
  }, [terminalInstance]);

  const { selectionText, handleCopySelection } = state;

  const handleCopyClick = React.useCallback(() => {
    if (selectionText) {
      void handleCopySelection();
      return;
    }
    // 没有选区时直接打开快照面板：TUI 里拖动经常选不中，硬复制只会得到空内容。
    openCopyPanel();
  }, [selectionText, handleCopySelection, openCopyPanel]);

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
      const clampedWidth = Math.max(50, Math.min(maxWidth, newWidth));
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
          <div className="relative flex-1 p-4 pb-2 min-h-0">
            <div
              ref={state.terminalRef}
              className={`h-full w-full rounded-lg border ${state.isDark ? "border-slate-800" : "border-slate-300 xterm-light"} ${state.sessionInfo?.enhanced_enabled ? "xterm-tmux-enhanced" : ""}`}
              tabIndex={-1}
              onClick={() => state.terminalInstance.current?.focus()}
            />
            {state.screenFrozen ? (
              <div
                className={`pointer-events-none absolute left-1/2 top-6 z-10 -translate-x-1/2 rounded-full border px-3 py-1 text-xs shadow-lg ${
                  state.isDark
                    ? "border-amber-500/50 bg-amber-500/15 text-amber-200"
                    : "border-amber-400 bg-amber-50 text-amber-700"
                }`}
              >
                {state.t(
                  "已暂停刷新，可自由选中文本后复制（Esc 退出）",
                  "Refresh paused — select text freely, then copy (Esc to exit)"
                )}
              </div>
            ) : null}
            <div className="pointer-events-none absolute bottom-4 right-6 z-10 flex flex-col items-end gap-2">
              {state.selectionText ? (
                <div
                  className={`pointer-events-auto rounded-full border px-3 py-1 text-[11px] shadow-sm ${
                    state.isDark
                      ? "border-slate-700 bg-slate-900/90 text-slate-300"
                      : "border-slate-300 bg-white/95 text-slate-600"
                  }`}
                >
                  {state.t(
                    `已选 ${state.selectionText.length} 字符`,
                    `${state.selectionText.length} chars selected`
                  )}
                </div>
              ) : null}
              <div
                className={`pointer-events-auto flex items-center gap-1 rounded-lg border p-1 shadow-lg backdrop-blur ${
                  state.isDark ? "border-slate-700 bg-slate-900/90" : "border-slate-300 bg-white/95"
                }`}
              >
                <Button
                  variant={state.selectionText ? "primary" : "ghost"}
                  lightMode={!state.isDark}
                  className="h-8 px-2.5 text-xs"
                  onClick={handleCopyClick}
                  title={state.t("复制选中文本；未选中时打开选择复制面板", "Copy selection, or open the copy panel")}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  {state.t("复制", "Copy")}
                </Button>
                <Button
                  variant="ghost"
                  lightMode={!state.isDark}
                  className="h-8 px-2.5 text-xs"
                  onClick={openCopyPanel}
                  title={state.t("从终端输出快照中选择复制", "Copy from a text snapshot of the terminal")}
                >
                  <ScanText className="h-3.5 w-3.5" aria-hidden="true" />
                  {state.t("选择复制", "Select")}
                </Button>
                <Button
                  variant={state.screenFrozen ? "primary" : "ghost"}
                  lightMode={!state.isDark}
                  className="h-8 px-2.5 text-xs"
                  onClick={state.toggleScreenFrozen}
                  title={state.t(
                    "冻结画面并接管鼠标，TUI 重绘时也能稳定选中文本",
                    "Freeze the screen and take over the mouse so TUI redraws cannot clear the selection"
                  )}
                >
                  {state.screenFrozen ? state.t("恢复刷新", "Resume") : state.t("选择模式", "Freeze")}
                </Button>
              </div>
            </div>
            {copySnapshot ? (
              <TerminalCopyPanel
                snapshot={copySnapshot}
                isDark={state.isDark}
                t={state.t}
                onCopy={state.copyText}
                onClose={closeCopyPanel}
              />
            ) : null}
          </div>
          <div className={`p-4 pt-2 ${state.isDark ? "border-t border-slate-800" : "border-t border-slate-200"}`} style={{ height: "280px" }}>
            {state.sessionId ? (
              <React.Suspense fallback={<TerminalPanelFallback isDark={state.isDark} />}>
                <FileBrowser
                  sessionId={state.sessionId}
                  isDark={state.isDark}
                  currentDir={state.currentDir}
                  onFileSelect={state.setSelectedFilePath}
                  networkProfile={state.sessionNetworkProfile}
                />
              </React.Suspense>
            ) : null}
          </div>
        </div>
        <div
          onMouseDown={handleMouseDown}
          className={`w-1 cursor-col-resize transition-colors hidden lg:block ${
            isDragging
              ? (state.isDark ? "bg-indigo-500" : "bg-indigo-400")
              : (state.isDark ? "bg-slate-800 hover:bg-slate-700" : "bg-slate-200 hover:bg-slate-300")
          }`}
        />
        <div
          style={{ width: sidebarWidth }}
          className={`p-4 hidden lg:block flex-shrink-0 overflow-y-auto ${state.isDark ? "bg-slate-900/50 dark-scrollbar" : "bg-white border-l border-slate-200 light-scrollbar"}`}
        >
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
