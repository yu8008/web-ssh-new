import React from "react";
import {
  ArrowDown,
  ArrowUp,
  Circle,
  Loader2,
  LogOut,
  Moon,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ScrollText,
  Server,
  StickyNote,
  Sun,
  Unplug,
  UserRound,
  WifiOff,
  X,
  Pencil,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import { clearAuthStorage } from "../../lib/api";
import type { Connection, Session } from "../../lib/api";
import type { SessionsState } from "./useSessionsState";
import { ConnectionDialog } from "./ConnectionDialog";
import { SessionsDialogs } from "./SessionsDialogs";

type SessionsWorkbenchProps = {
  state: SessionsState;
};

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function useOnlineStatus(): boolean {
  const [online, setOnline] = React.useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  React.useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

function relativeTime(iso: string | null | undefined, t: (zh: string, en: string) => string): string {
  if (!iso) return "—";
  const value = new Date(iso).getTime();
  if (!Number.isFinite(value)) return "—";
  const diff = Date.now() - value;
  if (diff < 45_000) return t("刚刚", "just now");
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return t(minutes + " 分钟前", minutes + " min ago");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t(hours + " 小时前", hours + " h ago");
  const days = Math.round(hours / 24);
  if (days < 30) return t(days + " 天前", days + " d ago");
  return new Date(iso).toLocaleDateString();
}

function durationSince(iso: string, t: (zh: string, en: string) => string): string {
  const started = new Date(iso).getTime();
  if (!Number.isFinite(started)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - started) / 60_000));
  if (minutes < 1) return t("不到 1 分钟", "under a minute");
  if (minutes < 60) return t(minutes + " 分钟", minutes + " min");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return t(hours + " 小时" + (rest ? " " + rest + " 分" : ""), hours + "h" + (rest ? " " + rest + "m" : ""));
}

export function SessionsWorkbench({ state }: SessionsWorkbenchProps) {
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const [connectionFilter, setConnectionFilter] = React.useState("");
  const [activeConnectionId, setActiveConnectionId] = React.useState<number | null>(null);
  const [openMenuId, setOpenMenuId] = React.useState<string | null>(null);
  const [noteSessionId, setNoteSessionId] = React.useState<string | null>(null);
  const [userMenuOpen, setUserMenuOpen] = React.useState(false);
  const [railOpen, setRailOpen] = React.useState(false);

  const searchRef = React.useRef<HTMLInputElement>(null);
  const search = state.search.trim().toLowerCase();
  const visibleConnections = React.useMemo(() => {
    const term = (connectionFilter || search).toLowerCase();
    if (!term) return state.connections;
    return state.connections.filter((connection) =>
      [connection.name, connection.host, connection.username].some((field) =>
        String(field ?? "").toLowerCase().includes(term)
      )
    );
  }, [connectionFilter, search, state.connections]);

  const sessionsForRail = React.useMemo(() => {
    const counts = new Map<number, number>();
    state.sessions.forEach((session) => {
      if (session.status === "active") {
        counts.set(session.connection_id, (counts.get(session.connection_id) ?? 0) + 1);
      }
    });
    return counts;
  }, [state.sessions]);

  const visibleSessions = React.useMemo(() => {
    if (activeConnectionId === null) return state.filteredSessions;
    return state.filteredSessions.filter((session) => session.connection_id === activeConnectionId);
  }, [activeConnectionId, state.filteredSessions]);

  const activeCount = state.sessions.filter((session) => session.status === "active").length;
  const idleCount = state.sessions.length - activeCount;
  const activeConnection = state.connections.find((connection) => connection.id === activeConnectionId) ?? null;

  const openSession = (session: Session) => {
    navigate("/terminal/" + session.id);
  };

  React.useEffect(() => {
    if (activeConnectionId !== null && !state.connections.some((connection) => connection.id === activeConnectionId)) {
      setActiveConnectionId(null);
    }
  }, [activeConnectionId, state.connections]);

  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas text-ink">
      <header className="relative z-30 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-chrome px-3 sm:px-4">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-brand/12 text-brand ring-1 ring-inset ring-brand/25">
            <TerminalGlyph />
          </span>
          <span className="text-sm font-semibold tracking-tight">WebSSH</span>
          <span className="hidden text-2xs text-muted sm:inline">工作台</span>
        </div>

        <label className="relative ml-1 hidden w-full max-w-[360px] items-center md:flex">
          <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted" aria-hidden="true" />
          <Input
            ref={searchRef}
            value={state.search}
            onChange={(event) => state.setSearch(event.target.value)}
            placeholder={state.t("搜索会话、连接或主机", "Search sessions, connections, hosts")}
            aria-label={state.t("搜索", "Search")}
            className="h-9 pl-8 pr-8 text-sm"
          />
          {state.search ? (
            <button
              type="button"
              onClick={() => state.setSearch("")}
              className="absolute right-1.5 grid h-6 w-6 place-items-center rounded text-muted hover:bg-elevated hover:text-ink"
              aria-label={state.t("清除搜索", "Clear search")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </label>

        <div className="ml-auto flex items-center gap-1">
          {!online ? (
            <span className="hidden items-center gap-1.5 rounded-full border border-warn/40 bg-warn/10 px-2.5 py-1 text-2xs font-medium text-warn sm:flex">
              <WifiOff className="h-3 w-3" />
              {state.t("网络已断开", "Offline")}
            </span>
          ) : null}
          <span className={cx("hidden items-center gap-1.5 px-2 text-2xs sm:flex", "text-muted")}>
            <span className={cx("h-1.5 w-1.5 rounded-full", state.networkProfileTone)} />
            {state.networkProfileLabel}
          </span>
          <IconAction label={state.t("切换主题", "Toggle theme")} onClick={state.toggleTheme}>
            {state.isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </IconAction>
          <IconAction label={state.t("语言", "Language")} onClick={state.toggleLanguage} className="hidden sm:grid">
            <span className="text-2xs font-semibold">{state.language === "en-US" ? "中" : "EN"}</span>
          </IconAction>
          <IconAction label={state.t("系统设置", "Settings")} onClick={() => { window.location.href = "/settings"; }}>
            <Settings className="h-4 w-4" />
          </IconAction>
          <IconAction label={state.t("系统日志", "Logs")} onClick={() => { window.location.href = "/logs"; }}>
            <ScrollText className="h-4 w-4" />
          </IconAction>
          <div className="relative">
            <button
              type="button"
              onClick={() => setUserMenuOpen((value) => !value)}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              className="ml-1 grid h-8 w-8 place-items-center rounded-full bg-elevated text-xs font-semibold text-ink ring-1 ring-inset ring-line hover:ring-line-strong"
            >
              <UserRound className="h-4 w-4" />
            </button>
            {userMenuOpen ? (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setUserMenuOpen(false)} />
                <div
                  role="menu"
                  className="animate-pop-in absolute right-0 top-10 z-40 w-44 overflow-hidden rounded-lg border border-line bg-surface p-1 shadow-panel"
                >
                  <button
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-xs text-ink-soft hover:bg-elevated hover:text-ink"
                    onClick={() => {
                      setUserMenuOpen(false);
                      state.setPasswordDialogOpen(true);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    {state.t("修改密码", "Change password")}
                  </button>
                  <button
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-xs text-danger hover:bg-danger/10"
                    onClick={() => {
                      clearAuthStorage();
                      window.location.href = "/";
                    }}
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    {state.t("退出登录", "Sign out")}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className={cx(
            "z-20 flex w-[280px] shrink-0 flex-col border-r border-line bg-chrome",
            "max-lg:fixed max-lg:inset-y-14 max-lg:left-0 max-lg:shadow-panel",
            railOpen ? "max-lg:flex" : "max-lg:hidden",
            "lg:flex"
          )}
          aria-label={state.t("连接列表", "Connections")}
        >
          <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
              {state.t("连接", "Connections")}
              <span className="ml-1.5 font-normal text-muted/70">{state.connections.length}</span>
            </h2>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => state.setShowCreateForm(true)}
              className="h-7 gap-1 px-2 text-2xs"
            >
              <Plus className="h-3.5 w-3.5" />
              {state.t("新建", "New")}
            </Button>
          </div>
          <div className="px-3 pb-2">
            <Input
              value={connectionFilter}
              onChange={(event) => setConnectionFilter(event.target.value)}
              placeholder={state.t("筛选连接", "Filter connections")}
              className="h-8 text-xs"
            />
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {activeConnectionId !== null ? (
              <button
                type="button"
                onClick={() => setActiveConnectionId(null)}
                className="mb-2 flex w-full items-center justify-between rounded-md border border-brand/30 bg-brand/8 px-2.5 py-1.5 text-2xs text-brand"
              >
                <span className="truncate">{activeConnection?.name}</span>
                <X className="h-3 w-3" />
              </button>
            ) : null}
            {visibleConnections.length === 0 ? (
              <div className="px-2 py-6 text-center text-2xs text-muted">
                {state.connections.length === 0
                  ? state.t("还没有连接", "No connections yet")
                  : state.t("没有匹配的连接", "No matching connections")}
              </div>
            ) : (
              <ul className="space-y-0.5">
                {visibleConnections.map((connection) => (
                  <ConnectionItem
                    key={connection.id}
                    state={state}
                    connection={connection}
                    activeSessions={sessionsForRail.get(connection.id) ?? 0}
                    selected={activeConnectionId === connection.id}
                    onSelect={() => setActiveConnectionId(connection.id === activeConnectionId ? null : connection.id)}
                  />
                ))}
              </ul>
            )}
          </nav>
          <div className="border-t border-line px-3 py-2 text-2xs text-muted">
            {online ? state.t("已连接服务端", "Connected to gateway") : state.t("离线，操作已暂停", "Offline")}
          </div>
        </aside>

        {railOpen ? <div className="fixed inset-0 z-10 bg-black/40 lg:hidden" onClick={() => setRailOpen(false)} /> : null}

        <main className="flex min-w-0 flex-1 flex-col bg-content">
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setRailOpen(true)} aria-label={state.t("打开连接列表", "Open connections")}>
              <Server className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold">{state.t("会话", "Sessions")}</h1>
              <p className="text-2xs text-muted">
                {state.t(activeCount + " 个在线 · " + idleCount + " 个离线", activeCount + " active · " + idleCount + " idle")}
                {activeConnection ? " · " + activeConnection.name : ""}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <div className="flex items-center rounded-md border border-line bg-surface p-0.5" role="group" aria-label={state.t("状态筛选", "Status filter")}>
                {[
                  { value: "all", label: state.t("全部", "All") },
                  { value: "active", label: state.t("在线", "Active") },
                  { value: "disconnected", label: state.t("离线", "Idle") },
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={state.filter === option.value}
                    onClick={() => state.setFilter(option.value)}
                    className={cx(
                      "h-7 rounded px-2.5 text-2xs font-medium transition",
                      state.filter === option.value ? "bg-elevated text-ink shadow-sm" : "text-muted hover:text-ink"
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <Button variant="primary" size="sm" onClick={() => state.setShowCreateForm(true)} className="hidden sm:inline-flex">
                <Plus className="h-3.5 w-3.5" />
                {state.t("新建连接", "New connection")}
              </Button>
            </div>
          </div>

          {state.loadError ? (
            <div className="mx-4 mt-3 flex items-center gap-3 rounded-md border border-danger/30 bg-danger/8 px-3 py-2 text-xs text-danger sm:mx-5">
              <span className="min-w-0 flex-1 truncate">{state.loadError}</span>
              <Button size="sm" variant="ghost" className="h-7 text-2xs" onClick={() => state.reload()}>
                <RefreshCw className="h-3.5 w-3.5" />
                {state.t("重试", "Retry")}
              </Button>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {state.loading ? (
              <SkeletonRows />
            ) : visibleSessions.length === 0 ? (
              <EmptySessions
                state={state}
                hasFilter={Boolean(state.search) || state.filter !== "all" || activeConnectionId !== null}
                onClear={() => {
                  state.setSearch("");
                  state.setFilter("all");
                  setActiveConnectionId(null);
                }}
                onCreate={() => state.setShowCreateForm(true)}
              />
            ) : (
              <ul className="divide-y divide-line/70">
                {visibleSessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    state={state}
                    session={session}
                    menuOpen={openMenuId === session.id}
                    noteOpen={noteSessionId === session.id}
                    onToggleMenu={() => setOpenMenuId((current) => (current === session.id ? null : session.id))}
                    onToggleNote={() => setNoteSessionId((current) => (current === session.id ? null : session.id))}
                    onOpen={() => openSession(session)}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-line px-4 text-2xs text-muted sm:px-5">
            <span className="truncate">
              {state.t(
                "按 / 搜索 · 点击左侧连接筛选会话 · Enter 打开当前聚焦的会话",
                "Press / to search · pick a connection to filter · Enter opens the focused session"
              )}
            </span>
            <button
              type="button"
              onClick={() => void state.reload()}
              className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 transition hover:bg-elevated hover:text-ink"
            >
              <RefreshCw className="h-3 w-3" />
              {state.t("刷新", "Refresh")}
            </button>
          </div>
        </main>
      </div>

      <ConnectionDialog state={state} />
      <SessionsDialogs state={state} />
    </div>
  );
}

function IconAction({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cx(
        "grid h-8 w-8 place-items-center rounded-md text-ink-soft transition hover:bg-elevated hover:text-ink",
        className
      )}
    >
      {children}
    </button>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M14 5h5v5M19 5l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TerminalGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
      <path d="M5 7l4 5-4 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 17h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ConnectionItem({
  state,
  connection,
  activeSessions,
  selected,
  onSelect,
}: {
  state: SessionsState;
  connection: Connection;
  activeSessions: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const verified = connection.remote_probe_status === "verified";
  const failed = connection.remote_probe_status === "failed";
  const verifying = connection.remote_probe_status === "verifying" || Boolean(state.verifyingConnectionIds[connection.id]);
  const connecting = state.connectingId === connection.id;

  return (
    <li>
      <div
        className={cx(
          "group flex items-center gap-2 rounded-md px-2 py-1.5 transition",
          selected ? "bg-brand/10 text-ink ring-1 ring-inset ring-brand/25" : "hover:bg-elevated"
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-pressed={selected}
        >
          <StatusDot tone={verifying ? "warn" : failed ? "danger" : verified ? "ok" : "muted"} pulse={verifying} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{connection.name}</span>
            <span className="block truncate font-mono text-2xs text-muted">
              {connection.username}@{connection.host}
            </span>
          </span>
        </button>
        <span className="flex items-center gap-1">
          {activeSessions > 0 ? (
            <span className="rounded-full bg-ok/12 px-1.5 py-0.5 text-[10px] font-semibold text-ok" title={state.t("在线会话", "Active sessions")}>
              {activeSessions}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => state.handleCreateSession(connection.id)}
            disabled={connecting}
            title={state.t("启动会话", "Start session")}
            aria-label={state.t("启动会话", "Start session")}
            className={cx(
              "grid h-6 w-6 place-items-center rounded text-muted transition",
              "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              "hover:bg-brand/15 hover:text-brand"
            )}
          >
            {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => state.handleEditConnection(connection)}
            title={state.t("编辑连接", "Edit connection")}
            aria-label={state.t("编辑连接", "Edit connection")}
            className="grid h-6 w-6 place-items-center rounded text-muted opacity-0 transition hover:bg-elevated hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
          >
            <Pencil className="h-3 w-3" />
          </button>
        </span>
      </div>
    </li>
  );
}

function StatusDot({ tone, pulse }: { tone: "ok" | "warn" | "danger" | "muted"; pulse?: boolean }) {
  const color = tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : tone === "danger" ? "bg-danger" : "bg-muted/60";
  return (
    <span className="relative grid h-3 w-3 shrink-0 place-items-center" aria-hidden="true">
      <span className={cx("h-1.5 w-1.5 rounded-full", color, pulse && "animate-pulse-soft")} />
      {tone === "ok" ? <span className="absolute inset-0 rounded-full bg-ok/20" /> : null}
    </span>
  );
}

function SessionRow({
  state,
  session,
  menuOpen,
  noteOpen,
  onToggleMenu,
  onToggleNote,
  onOpen,
}: {
  state: SessionsState;
  session: Session;
  menuOpen: boolean;
  noteOpen: boolean;
  onToggleMenu: () => void;
  onToggleNote: () => void;
  onOpen: () => void;
}) {
  const active = session.status === "active";
  const retrying = Boolean(state.retryingSessionIds[session.id]) || state.isSystemRetrying(session);
  const [renaming, setRenaming] = React.useState(false);
  const [draftName, setDraftName] = React.useState(session.name);

  React.useEffect(() => {
    if (!renaming) {
      setDraftName(session.name);
    }
  }, [session.name, renaming]);

  const commitRename = () => {
    setRenaming(false);
    const next = draftName.trim();
    if (next && next !== session.name) {
      void state.handleRenameSession(session, next);
    }
  };

  const noteValue = state.noteDrafts[session.id] ?? "";
  const noteDirty = noteValue.trim() !== (session.note ?? "");
  const scope = state.filteredSessions;

  return (
    <li className="group relative">
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
        aria-label={state.t("打开会话 " + session.name, "Open session " + session.name)}
        className="flex cursor-pointer items-center gap-3 px-4 py-3 outline-none transition hover:bg-elevated/60 focus-visible:bg-elevated/60 sm:px-5"
      >
        <StatusDot tone={active ? "ok" : retrying ? "warn" : "muted"} pulse={active || retrying} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {renaming ? (
              <input
                autoFocus
                value={draftName}
                maxLength={64}
                onChange={(event) => setDraftName(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setRenaming(false);
                    setDraftName(session.name);
                  }
                }}
                onBlur={commitRename}
                aria-label={state.t("会话标题", "Session title")}
                className="h-6 w-44 rounded border border-brand/50 bg-canvas px-1.5 text-sm font-medium text-ink outline-none focus:ring-2 focus:ring-brand/25"
              />
            ) : (
              <>
                <span className="truncate text-sm font-medium">{session.name}</span>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDraftName(session.name);
                    setRenaming(true);
                  }}
                  aria-label={state.t("重命名会话", "Rename session")}
                  title={state.t("重命名会话", "Rename session")}
                  className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted opacity-0 transition hover:bg-elevated hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </>
            )}
            {session.enhanced_enabled ? (
              <span className="rounded border border-brand/25 bg-brand/8 px-1.5 py-px text-[10px] font-medium text-brand">
                {state.t("持久", "Persistent")}
              </span>
            ) : null}
            {retrying ? (
              <span className="rounded border border-warn/30 bg-warn/10 px-1.5 py-px text-[10px] font-medium text-warn">
                {state.t("重试中", "Retrying")}
              </span>
            ) : null}
            {noteValue.trim() ? <StickyNote className="h-3 w-3 shrink-0 text-muted/70" aria-hidden="true" /> : null}
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted">
            <span className="truncate font-mono">
              {session.username}@{session.host}
            </span>
            <span aria-hidden="true">·</span>
            <span>{active ? state.t("已运行 ", "up ") + durationSince(session.started_at, state.t) : state.mapSessionStatus(session.status)}</span>
            <span aria-hidden="true">·</span>
            <span>{state.t("最近活动 ", "last seen ") + relativeTime(session.last_activity, state.t)}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {active ? (
            <Button size="sm" variant="secondary" className="hidden group-hover:inline-flex group-focus-within:inline-flex sm:inline-flex">
              {state.t("打开", "Open")}
            </Button>
          ) : session.enhanced_enabled && session.allow_auto_retry !== false ? (
            <Button
              size="sm"
              variant="secondary"
              loading={retrying}
              onClick={(event) => {
                event.stopPropagation();
                state.handleRetryEnhancedSession(session.id);
              }}
            >
              {state.t("重连", "Reconnect")}
            </Button>
          ) : null}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleMenu();
            }}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={state.t("更多操作", "More actions")}
            className="grid h-8 w-8 place-items-center rounded-md text-muted transition hover:bg-elevated hover:text-ink"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>
      </div>

      {menuOpen ? (
        <>
          <div className="fixed inset-0 z-20" onClick={onToggleMenu} />
          <div role="menu" className="animate-pop-in absolute right-4 top-12 z-30 w-44 overflow-hidden rounded-lg border border-line bg-surface p-1 shadow-panel sm:right-5">
            <MenuItem
              icon={<ExternalIcon />}
              label={state.t("在新标签页打开", "Open in new tab")}
              onClick={() => {
                onToggleMenu();
                window.open("/terminal/" + session.id, "_blank", "noopener");
              }}
            />
            <MenuItem
              icon={<StickyNote className="h-3.5 w-3.5" />}
              label={state.t("备注", "Note")}
              onClick={() => {
                onToggleMenu();
                onToggleNote();
              }}
            />
            <MenuItem
              icon={<ArrowUp className="h-3.5 w-3.5" />}
              label={state.t("上移", "Move up")}
              disabled={state.ordering.savingOrder}
              onClick={() => {
                onToggleMenu();
                state.ordering.handleMoveSession(session.id, "up", scope);
              }}
            />
            <MenuItem
              icon={<ArrowDown className="h-3.5 w-3.5" />}
              label={state.t("下移", "Move down")}
              disabled={state.ordering.savingOrder}
              onClick={() => {
                onToggleMenu();
                state.ordering.handleMoveSession(session.id, "down", scope);
              }}
            />
            <div className="my-1 h-px bg-line" />
            <MenuItem
              icon={active ? <Unplug className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
              label={active ? state.t("断开", "Disconnect") : state.t("删除", "Delete")}
              danger
              onClick={() => {
                onToggleMenu();
                state.handleDisconnectOrDelete(session);
              }}
            />
          </div>
        </>
      ) : null}

      {noteOpen ? (
        <div className="border-t border-line/70 bg-surface px-4 py-3 sm:px-5">
          <label className="mb-1 block text-2xs text-muted" htmlFor={"note-" + session.id}>
            {state.t("这个会话的备注，最多 1000 字", "Session note, up to 1000 characters")}
          </label>
          <textarea
            id={"note-" + session.id}
            value={noteValue}
            maxLength={1000}
            autoFocus
            onChange={(event) => state.handleNoteChange(session.id, event.target.value)}
            className="h-20 w-full resize-none rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink focus:border-brand/70 focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onToggleNote}>
              {state.t("收起", "Close")}
            </Button>
            <Button size="sm" variant="primary" disabled={!noteDirty} onClick={() => state.handleSaveNote(session)}>
              {state.t("保存备注", "Save note")}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs transition disabled:opacity-40",
        danger ? "text-danger hover:bg-danger/10" : "text-ink-soft hover:bg-elevated hover:text-ink"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function SkeletonRows() {
  return (
    <div aria-hidden="true" className="divide-y divide-line/70">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex items-center gap-3 px-5 py-3">
          <div className="h-1.5 w-1.5 rounded-full bg-line-strong" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-40 animate-pulse rounded bg-elevated" />
            <div className="h-2.5 w-64 animate-pulse rounded bg-elevated/70" />
          </div>
          <div className="h-7 w-16 animate-pulse rounded-md bg-elevated" />
        </div>
      ))}
    </div>
  );
}

function EmptySessions({
  state,
  hasFilter,
  onClear,
  onCreate,
}: {
  state: SessionsState;
  hasFilter: boolean;
  onClear: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="animate-fade-in flex min-h-[320px] flex-col items-center justify-center px-6 py-16 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-surface text-muted">
        <Circle className="h-4 w-4" />
      </span>
      <p className="mt-4 text-sm font-medium">
        {hasFilter ? state.t("没有匹配的会话", "No matching sessions") : state.t("还没有会话", "No sessions yet")}
      </p>
      <p className="mt-1 max-w-sm text-xs text-muted">
        {hasFilter
          ? state.t("换个关键词，或清除筛选看看全部会话。", "Try another keyword, or clear filters to see all sessions.")
          : state.t("从左侧选择一个连接启动会话，或先新建一个连接。", "Start a session from a connection on the left, or add a new connection first.")}
      </p>
      <div className="mt-4 flex gap-2">
        {hasFilter ? (
          <Button size="sm" variant="secondary" onClick={onClear}>
            {state.t("清除筛选", "Clear filters")}
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={onCreate}>
            <Plus className="h-3.5 w-3.5" />
            {state.t("新建连接", "New connection")}
          </Button>
        )}
      </div>
    </div>
  );
}
