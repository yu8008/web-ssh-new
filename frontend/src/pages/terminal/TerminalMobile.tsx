import React from "react";
import { Copy } from "lucide-react";
import { Button } from "../../components/Button";
import { FileViewer } from "../../components/FileViewer";
import type { FileInfo } from "../../lib/api";
import { TerminalCopyPanel } from "./TerminalCopyPanel";
import { createTerminalBufferSnapshot, type TerminalBufferSnapshot } from "./terminalUtils";
import type { TerminalSessionState } from "./useTerminalSession";

const FileBrowser = React.lazy(() =>
  import("../../components/FileBrowser").then((module) => ({ default: module.FileBrowser }))
);
const SystemMonitor = React.lazy(() =>
  import("../../components/SystemMonitor").then((module) => ({ default: module.SystemMonitor }))
);

type TerminalMobileProps = {
  state: TerminalSessionState;
  onBack: () => void;
};

type MobileTab = "terminal" | "files" | "system";

function MobilePanelFallback({ isDark }: { isDark: boolean }) {
  return (
    <div className={`flex h-full min-h-[180px] items-center justify-center rounded-lg border text-sm ${isDark ? "border-slate-800 bg-slate-900/40 text-slate-400" : "border-slate-200 bg-white text-slate-500"}`}>
      加载中... / Loading...
    </div>
  );
}

export function TerminalMobile({ state, onBack }: TerminalMobileProps) {
  const [activeTab, setActiveTab] = React.useState<MobileTab>("terminal");
  const [copySnapshot, setCopySnapshot] = React.useState<TerminalBufferSnapshot | null>(null);
  const [openedFile, setOpenedFile] = React.useState<FileInfo | null>(null);
  const closeViewer = React.useCallback(() => setOpenedFile(null), []);
  const { syncTerminalSize, terminalInstance, scrollTerminal } = state;

  React.useEffect(() => {
    if (activeTab !== "terminal") {
      return;
    }
    const term = terminalInstance.current;
    if (!term) {
      return;
    }
    syncTerminalSize(term, { force: true });
    term.focus();
  }, [activeTab, syncTerminalSize, terminalInstance]);

  React.useEffect(() => {
    setCopySnapshot(null);
  }, [state.sessionId]);

  const openCopyMode = React.useCallback(() => {
    const buffer = terminalInstance.current?.buffer.active;
    if (!buffer) {
      return;
    }
    setCopySnapshot(createTerminalBufferSnapshot(buffer));
  }, [terminalInstance]);

  const closeCopyMode = React.useCallback(() => {
    setCopySnapshot(null);
    window.requestAnimationFrame(() => terminalInstance.current?.focus());
  }, [terminalInstance]);

  const changeTab = React.useCallback((tab: MobileTab) => {
    if (tab !== "terminal") {
      setCopySnapshot(null);
    }
    setActiveTab(tab);
  }, []);

  const actions = [
    {
      key: "language",
      label: state.language === "en-US" ? "中文" : "EN",
      onClick: state.toggleLanguage,
      variant: "ghost" as const,
    },
    {
      key: "theme",
      label: state.isDark ? state.t("浅色", "Light") : state.t("深色", "Dark"),
      onClick: state.toggleTheme,
      variant: "ghost" as const,
    },
    {
      key: "copy",
      label: state.t("选择复制", "Select and copy"),
      onClick: openCopyMode,
      variant: "secondary" as const,
    },
    {
      key: "clear",
      label: state.t("清屏", "Clear"),
      onClick: state.handleClear,
      variant: "ghost" as const,
    },
  ];

  const shouldShowReconnect = state.connectionState === "closed" && state.reconnectCountdown === null;
  const shouldShowCancelReconnect = state.connectionState === "closed" && state.reconnectCountdown !== null;

  return (
    <div className={`flex h-screen flex-col overflow-hidden transition-colors duration-300 supports-[height:100dvh]:h-dvh ${state.isDark ? "bg-slate-950 text-slate-100 dark-scrollbar" : "bg-gray-100 text-slate-900 light-scrollbar"}`}>
      <div className={`border-b px-4 py-3 ${state.isDark ? "border-slate-800" : "border-slate-200 bg-white"}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className={`text-base font-semibold truncate ${state.isDark ? "text-slate-100" : "text-slate-800"}`}>
              {state.sessionInfo?.name || state.t("会话", "Session")}
            </div>
            <div className={`text-xs truncate ${state.isDark ? "text-slate-500" : "text-slate-400"}`}>
              {state.sessionInfo ? new Date(state.sessionInfo.started_at).toLocaleString() : ""}
            </div>
          </div>
          <Button variant="secondary" lightMode={!state.isDark} onClick={onBack} className="min-h-11 px-3 py-2 text-xs whitespace-nowrap">
            {state.t("返回", "Back")}
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className={`${state.connectionTone}`}>
            {state.reconnectCountdown !== null ? state.t(`重连中 (${state.reconnectCountdown}s)`, `Reconnecting (${state.reconnectCountdown}s)`) : state.connectionLabel}
          </span>
          <span className={`${state.networkProfileTone}`}>{state.networkProfileLabel}</span>
          {state.targetLatencyMs !== null ? (
            <span className={state.isDark ? "text-slate-500" : "text-slate-400"}>
              {state.targetLatencyMs}ms
            </span>
          ) : null}
        </div>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {actions.map((action) => (
            <Button
              key={action.key}
              variant={action.variant}
              lightMode={!state.isDark}
              onClick={action.onClick}
              className="min-h-11 px-3 py-2 text-xs whitespace-nowrap"
            >
              {action.label}
            </Button>
          ))}
          {shouldShowCancelReconnect ? (
            <Button
              variant="ghost"
              lightMode={!state.isDark}
              onClick={state.handleCancelReconnect}
              className="min-h-11 px-3 py-2 text-xs whitespace-nowrap"
            >
              {state.t("取消重连", "Cancel reconnect")}
            </Button>
          ) : null}
          {shouldShowReconnect ? (
            <Button
              variant="secondary"
              lightMode={!state.isDark}
              onClick={state.handleReconnect}
              className="min-h-11 px-3 py-2 text-xs whitespace-nowrap"
            >
              {state.t("重连", "Reconnect")}
            </Button>
          ) : null}
        </div>
        {state.sessionInfo?.note ? (
          <div className={`mt-2 text-xs ${state.isDark ? "text-slate-500" : "text-slate-400"}`}>
            {state.sessionInfo.note}
          </div>
        ) : null}
      </div>

      <div className="flex-1 min-h-0 pb-16">
        <div className={`${activeTab === "terminal" ? "flex" : "hidden"} h-full flex-col`}>
          <div className="flex-1 p-3 min-h-0 relative">
            <div className="h-full w-full overflow-hidden rounded-lg border border-line" style={{ backgroundColor: state.isDark ? "#020617" : "#ffffff" }}>
              <div className={`h-full w-full p-2 ${state.isDark ? "" : "xterm-light"} ${state.sessionInfo?.enhanced_enabled ? "xterm-tmux-enhanced" : ""}`}>
                <div ref={state.terminalRef} className="h-full w-full" tabIndex={-1} onClick={() => state.terminalInstance.current?.focus()} />
              </div>
            </div>
            <div className="absolute right-4 bottom-4 flex flex-col gap-2">
              {state.selectionText ? (
                <button
                  type="button"
                  onClick={() => void state.handleCopySelection()}
                  className={`flex h-11 items-center justify-center gap-1 rounded-full border px-3 text-xs font-medium ${
                    state.isDark
                      ? "border-indigo-400/60 bg-indigo-500 text-white"
                      : "border-indigo-300 bg-indigo-500 text-white"
                  }`}
                  aria-label={state.t("复制选中内容", "Copy selected text")}
                >
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  {state.t("复制", "Copy")}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => scrollTerminal("up", "remote")}
                className={`h-11 w-11 rounded-full border text-base ${
                  state.isDark
                    ? "border-slate-700 bg-slate-900/90 text-slate-200"
                    : "border-slate-200 bg-white text-slate-700"
                }`}
                aria-label={state.t("向上滚动终端", "Scroll terminal up")}
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => scrollTerminal("down", "remote")}
                className={`h-11 w-11 rounded-full border text-base ${
                  state.isDark
                    ? "border-slate-700 bg-slate-900/90 text-slate-200"
                    : "border-slate-200 bg-white text-slate-700"
                }`}
                aria-label={state.t("向下滚动终端", "Scroll terminal down")}
              >
                ↓
              </button>
            </div>
            {copySnapshot ? (
              <TerminalCopyPanel
                snapshot={copySnapshot}
                isDark={state.isDark}
                t={state.t}
                onCopy={state.copyText}
                onClose={closeCopyMode}
              />
            ) : null}
          </div>
        </div>

        <div className={`${activeTab === "files" ? "flex" : "hidden"} h-full flex-col`}>
          <div className="flex-1 p-3 min-h-0">
            {state.sessionId ? (
              <React.Suspense fallback={<MobilePanelFallback isDark={state.isDark} />}>
                <FileBrowser
                  sessionId={state.sessionId}
                  isDark={state.isDark}
                  currentDir={state.currentDir}
                  onOpenFile={setOpenedFile}
                  networkProfile={state.sessionNetworkProfile}
                  compact
                />
              </React.Suspense>
            ) : null}
          </div>
        </div>

        <div className={`${activeTab === "system" ? "flex" : "hidden"} h-full flex-col`}>
          <div className="flex-1 p-3 min-h-0 overflow-y-auto">
            {state.sessionId ? (
              <React.Suspense fallback={<MobilePanelFallback isDark={state.isDark} />}>
                <SystemMonitor
                  sessionId={state.sessionId}
                  isDark={state.isDark}
                  networkProfile={state.sessionNetworkProfile}
                  compact
                />
              </React.Suspense>
            ) : null}
          </div>
        </div>
      </div>

      <div className={`fixed bottom-0 left-0 right-0 z-50 border-t ${state.isDark ? "border-slate-800 bg-slate-950" : "border-slate-200 bg-white"}`}>
        <div className="flex">
          {[
            { key: "terminal", label: state.t("终端", "Terminal") },
            { key: "files", label: state.t("文件", "Files") },
            { key: "system", label: state.t("系统", "System") },
          ].map((tab) => {
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => changeTab(tab.key as MobileTab)}
                className={`flex-1 py-3 text-sm font-medium transition ${
                  active
                    ? (state.isDark ? "text-indigo-300" : "text-indigo-600")
                    : (state.isDark ? "text-slate-400" : "text-slate-500")
                }`}
              >
                {tab.label}
              </button>
            );
          })}
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
