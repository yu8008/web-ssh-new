import React from "react";
import { FileText, Github } from "lucide-react";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import type { SessionsState } from "./useSessionsState";
import { SessionsConnectionsPanel } from "./SessionsConnectionsPanel";
import { SessionsDialogs } from "./SessionsDialogs";
import { clearAuthStorage } from "../../lib/api";
import { SessionCard } from "./SessionCard";
import { SessionEmptyState } from "./SessionEmptyState";
import { SessionGroupedList } from "./SessionGroupedList";
import { SessionViewModeToggle } from "./SessionViewModeToggle";
import { NotificationButton } from "../../notifications/NotificationProvider";

type SessionsDesktopProps = {
  state: SessionsState;
};

export function SessionsDesktop({ state }: SessionsDesktopProps) {
  if (state.loading) {
    return <div className={`p-6 ${state.isDark ? "text-ink" : "text-ink-soft"}`}>{state.t("加载中...", "Loading...")}</div>;
  }

  return (
    <div className={`min-h-screen px-6 py-8 transition-colors duration-300 ${state.isDark ? "bg-canvas text-ink dark-scrollbar" : "bg-canvas text-ink light-scrollbar"}`}>
      <div className="mx-auto max-w-6xl space-y-8">
        <div className={`flex items-center justify-between pb-6 ${state.isDark ? "border-b border-line" : "border-b border-line"}`}>
          <div>
            <h1 className="text-2xl font-semibold">{state.t("会话管理", "Session Management")}</h1>
            <p className={`text-sm ${state.isDark ? "text-muted" : "text-muted"}`}>
              {state.t("管理 SSH 连接与持久在线会话", "Manage SSH connections and persistent sessions")}
              <a
                href="https://github.com/yu8008/web-ssh-new"
                target="_blank"
                rel="noreferrer"
                className={`ml-2 inline-flex items-center gap-2 align-middle ${
                  state.isDark ? "text-ink-soft hover:text-ink" : "text-ink-soft hover:text-ink-soft"
                }`}
                aria-label={state.t("打开 GitHub 仓库", "Open GitHub repository")}
                title={state.t("打开 GitHub 仓库", "Open GitHub repository")}
              >
                <Github className="h-3.5 w-3.5" aria-hidden="true" /><span>GitHub</span>
              </a>
            </p>
            <p className={`text-xs mt-1 ${state.networkProfileTone}`}>{state.networkProfileLabel}</p>
          </div>
          <div className="flex items-center gap-2">
            <NotificationButton />
            <Button
              variant="ghost"
              lightMode={!state.isDark}
              onClick={state.toggleLanguage}
            >
              {state.language === "en-US" ? "中文" : "EN"}
            </Button>
            <Button
              variant="ghost"
              lightMode={!state.isDark}
              onClick={state.toggleTheme}
            >
              {state.isDark ? state.t("浅色", "Light") : state.t("深色", "Dark")}
            </Button>
            <Button
              variant="secondary"
              lightMode={!state.isDark}
              onClick={() => state.setPasswordDialogOpen(true)}
            >
              {state.t("修改密码", "Change password")}
            </Button>
            <Button
              variant="ghost"
              lightMode={!state.isDark}
              onClick={() => {
                clearAuthStorage();
                window.location.href = "/";
              }}
            >
              {state.t("退出登录", "Sign out")}
            </Button>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[2fr,1fr]">
          <div className="space-y-4">
            <div className={`rounded-lg border p-3 ${state.isDark ? "border-line bg-surface/35" : "border-line bg-surface shadow-sm"}`}>
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
                  <Input
                    placeholder={state.t("搜索会话名称", "Search session name")}
                    value={state.search}
                    onChange={(event) => state.setSearch(event.target.value)}
                    className={`min-w-[220px] max-w-sm flex-1 ${state.isDark ? "" : "border-line-strong bg-surface text-ink placeholder:text-muted"}`}
                  />
                  <div className="flex flex-wrap gap-2">
                    {[
                      { value: "all", label: state.t("全部", "All") },
                      { value: "active", label: state.t("在线", "Active") },
                      { value: "disconnected", label: state.t("离线", "Disconnected") },
                    ].map((item) => (
                      <Button
                        key={item.value}
                        variant={state.filter === item.value ? "primary" : "secondary"}
                        lightMode={!state.isDark}
                        onClick={() => state.setFilter(item.value)}
                      >
                        {item.label}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                  <SessionViewModeToggle
                    value={state.viewMode}
                    onChange={state.setViewMode}
                    isDark={state.isDark}
                    t={state.t}
                  />
                  <Button
                    variant="secondary"
                    lightMode={!state.isDark}
                    onClick={() => {
                      window.location.href = "/settings";
                    }}
                  >
                    {state.t("系统设置", "System Settings")}
                  </Button>
                  <Button
                    variant="secondary"
                    lightMode={!state.isDark}
                    onClick={() => {
                      window.location.href = "/logs";
                    }}
                  >
                    <FileText className="h-4 w-4" />
                    {state.t("日志", "Logs")}
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid gap-4">
              {state.viewMode === "grouped" ? (
                <SessionGroupedList state={state} layout="desktop" />
              ) : (
                <>
                  {state.filteredSessions.map((session) => (
                    <SessionCard key={session.id} state={state} session={session} layout="desktop" />
                  ))}
                  {state.filteredSessions.length === 0 ? <SessionEmptyState state={state} /> : null}
                </>
              )}
            </div>
          </div>

          <SessionsConnectionsPanel state={state} />
        </div>
      </div>

      <SessionsDialogs state={state} />
    </div>
  );
}
