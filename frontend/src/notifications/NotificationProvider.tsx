import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Bell, Circle, Volume2, VolumeX, X } from "lucide-react";
import { AppContext, useApp } from "../context/AppContextCore";
import { Button } from "../components/Button";
import { configureCliNotifications, openNotificationSocket, readTerminalNotification } from "../lib/api";
import { NotificationContext } from "./notificationContext";
import { DEFAULT_SOUND, SOUND_KEY, mergeNotices, parseNotice, parsePreferences, shouldSound, soundPriority } from "./notificationCore";
import type { NoticeKind, SoundPreferences, TerminalNotice } from "./notificationCore";
import { NotificationAudio } from "./notificationAudio";
import { claimNotificationSound } from "./notificationSpeaker";
import { parseRuntime, type CliRuntime } from "./notificationRuntime";
import { NotificationRuntimeStatus } from "./NotificationRuntimeStatus";

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, language } = useApp();
  const userId = user?.id; const token = user?.token;
  const t = React.useCallback((zh: string, en: string) => language === "en-US" ? en : zh, [language]);
  const location = useLocation(); const navigate = useNavigate();
  const sessionId = /^\/terminal\/([^/]+)$/.exec(location.pathname)?.[1];
  const currentSession = React.useRef(sessionId); currentSession.current = sessionId;
  const [events, setEvents] = React.useState<TerminalNotice[]>([]);
  const [preferences, setPreferences] = React.useState(() => { try { return parsePreferences(localStorage.getItem(SOUND_KEY)); } catch { return { ...DEFAULT_SOUND }; } });
  const [ready, setReady] = React.useState(false);
  const [audioError, setAudioError] = React.useState(false);
  const [connected, setConnected] = React.useState(false);
  const [opened, setOpened] = React.useState(false);
  const [toast, setToast] = React.useState<TerminalNotice | null>(null);
  const [setup, setSetup] = React.useState(""); const [busy, setBusy] = React.useState(false);
  const [runtime, setRuntime] = React.useState<CliRuntime | null>(null);
  const [configured, setConfigured] = React.useState(false);
  const setupRequest = React.useRef(0);
  const audio = React.useRef<NotificationAudio | null>(null);
  const settings = React.useRef(preferences); settings.current = preferences;
  const pending = React.useRef<NoticeKind | null>(null);
  const pendingTimer = React.useRef<number>();
  const pendingIds = React.useRef(new Set<string>());
  const seen = React.useRef(new Set<string>());
  const tabReady = React.useRef(false);
  const popupTrigger = React.useRef<HTMLElement | null>(null);
  const lastSound = React.useRef(0);
  const getAudio = React.useCallback(() => {
    audio.current ??= new NotificationAudio(value => { tabReady.current = value; setReady(value); });
    return audio.current;
  }, []);

  const update = React.useCallback((next: Partial<SoundPreferences>) => {
    setPreferences(previous => {
      const value = { ...previous, ...next };
      settings.current = value;
      try { localStorage.setItem(SOUND_KEY, JSON.stringify(value)); } catch { /* Keep session preferences. */ }
      if (!value.enabled || !value.volume) audio.current?.stop();
      return value;
    });
  }, []);
  const enable = React.useCallback(async () => {
    const player = getAudio();
    const enabled = await player.enable();
    setAudioError(!enabled);
    tabReady.current = enabled; setReady(enabled);
    if (enabled) { update({ enabled: true }); player.play("complete", settings.current.volume); }
  }, [update, getAudio]);
  const preview = React.useCallback(async (attention: boolean) => {
    const player = getAudio();
    const enabled = await player.enable();
    setAudioError(!enabled);
    tabReady.current = enabled; setReady(enabled);
    if (enabled) player.play(attention ? "question" : "complete", settings.current.volume);
  }, [getAudio]);

  React.useEffect(() => {
    const storage = (event: StorageEvent) => { if (event.key === SOUND_KEY) { const next = parsePreferences(event.newValue); settings.current = next; setPreferences(next); if (!next.enabled || !next.volume) audio.current?.stop(); } };
    const resume = () => {
      if (!settings.current.enabled || audio.current?.ready) return;
      void getAudio().enable().then(value => { tabReady.current = value; setReady(value); });
    };
    window.addEventListener("storage", storage);
    window.addEventListener("click", resume); window.addEventListener("keydown", resume);
    return () => { window.removeEventListener("storage", storage); window.removeEventListener("click", resume); window.removeEventListener("keydown", resume); };
  }, [getAudio]);

  React.useEffect(() => {
    seen.current.clear(); setEvents([]); setToast(null); setConnected(false);
    if (!userId || !token) return;
    const soundIds = pendingIds.current;
    let cancelled = false; let socket: WebSocket | null = null; let retry: number | undefined; let attempt = 0;
    const sound = (event: TerminalNotice) => {
      const foreground = document.visibilityState === "visible" && document.hasFocus();
      if (!tabReady.current || !audio.current?.ready || !shouldSound(event, settings.current, foreground)) return;
      pendingIds.current.add(event.id);
      if (pending.current === null || soundPriority(event.kind) > soundPriority(pending.current)) pending.current = event.kind;
      if (pendingTimer.current !== undefined) return;
      pendingTimer.current = window.setTimeout(() => {
        pendingTimer.current = undefined;
        const kind = pending.current; pending.current = null;
        const ids = [...pendingIds.current]; pendingIds.current.clear();
        if (!kind || cancelled || !settings.current.enabled) return;
        void claimNotificationSound(userId, ids).then(claimed => {
          if (claimed && !cancelled && settings.current.enabled && audio.current?.play(kind, settings.current.volume)) lastSound.current = Date.now();
        });
      }, Math.max(120, 350 - (Date.now() - lastSound.current)));
    };
    const connect = () => {
      if (cancelled) return;
      socket = openNotificationSocket();
      socket.onopen = () => { if (!cancelled) { attempt = 0; setConnected(true); } };
      socket.onmessage = message => {
        if (cancelled) return;
        try {
          const data = JSON.parse(message.data);
          if (data.type === "snapshot" && Array.isArray(data.events)) {
            const snapshot = data.events.map(parseNotice).filter((item: TerminalNotice | null): item is TerminalNotice => item !== null);
            snapshot.forEach((item: TerminalNotice) => seen.current.add(item.id));
            const ids = new Set(snapshot.map((item: TerminalNotice) => item.id));
            setEvents(previous => mergeNotices(previous.filter(item => ids.has(item.id)), snapshot));
          } else if (data.type === "notification") {
            const event = parseNotice(data.event);
            if (!event || seen.current.has(event.id)) return;
            seen.current.add(event.id);
            // Bounds memory in long-running tabs while preserving recent IDs.
            if (seen.current.size > 1000) seen.current = new Set([...seen.current].slice(-500));
            setEvents(previous => mergeNotices(previous, [event]));
            const age = Date.now() - Date.parse(event.created_at);
            if (age >= -5000 && age <= 10000 && !event.read_at) { setToast(event); sound(event); }
          } else if (data.type === "notification_runtime" && typeof data.session_id === "string" && encodeURIComponent(data.session_id) === currentSession.current) {
            const status = parseRuntime(data.runtime);
            if (status) setRuntime(status);
          } else if (data.type === "read" && typeof data.id === "string" && typeof data.read_at === "string") {
            setEvents(previous => previous.map(item => item.id === data.id ? { ...item, read_at: data.read_at } : item));
            setToast(previous => previous?.id === data.id ? null : previous);
          }
        } catch { /* Ignore malformed notifications without touching terminal IO. */ }
      };
      socket.onclose = close => {
        if (cancelled) return;
        setConnected(false);
        if (close.code === 1008) return;
        retry = window.setTimeout(connect, Math.min(20000, 1000 * 2 ** attempt++));
      };
      socket.onerror = () => socket?.close();
    };
    const heartbeat = window.setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
    }, 25000);
    connect();
    return () => {
      cancelled = true; socket?.close(); window.clearTimeout(retry); window.clearInterval(heartbeat); window.clearTimeout(pendingTimer.current);
      pendingTimer.current = undefined; pending.current = null; soundIds.clear();
    };
  }, [userId, token]);

  React.useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 8000); return () => window.clearTimeout(timer); }, [toast]);
  React.useEffect(() => () => audio.current?.dispose(), []);
  const open = React.useCallback(() => { popupTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setOpened(true); }, []);
  const close = React.useCallback(() => { setOpened(false); popupTrigger.current?.focus(); }, []);
  React.useEffect(() => {
    if (!opened) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [opened, close]);
  const label = (event: TerminalNotice) => event.kind === "complete" ? t("本轮回复结束", "Turn finished") : event.kind === "approval" ? t("等待操作批准", "Approval requested") : event.kind === "question" ? t("等待回答问题", "Question needs your answer") : event.kind === "attention" ? t("需要你处理", "Your attention is needed") : t("终端有提醒", "Terminal alert");
  const visit = (event: TerminalNotice) => {
    void readTerminalNotification(event.id).then(updated => setEvents(previous => mergeNotices(previous, [updated]))).catch(() => setSetup(t("未能标记已读，请稍后重试", "Could not mark as read; please retry")));
    setToast(null); setOpened(false); navigate(`/terminal/${encodeURIComponent(event.session_id)}`);
  };
  const configure = React.useCallback(async (action: "status" | "install" | "uninstall" | "bind", binding?: string) => {
    if (!sessionId) return;
    const request = ++setupRequest.current;
    setBusy(true); setSetup("");
    try {
      const status = await configureCliNotifications(decodeURIComponent(sessionId), action, binding);
      if (request !== setupRequest.current) return;
      if (status.installed && status.relay_active === false) status.notes.push(t("tmux 通知转发未连接，请重新接入。", "The tmux notification relay is disconnected; configure again."));
      setConfigured(status.installed);
      setRuntime(parseRuntime(status.runtime));
      const configurationLabel = (app: string) => {
        const value = status.configuration?.[app];
        return value === "configured" ? t("配置已验证", "configuration verified") : value === "changed" ? t("配置已变更，请重新接入", "configuration changed; configure again") : value === "missing" ? t("配置文件缺失", "configuration missing") : value === "unavailable" ? t("无法验证配置", "cannot verify configuration") : t("未由网关配置", "not configured by gateway");
      };
      setSetup(`${status.installed ? t("已保存接入记录", "Setup record saved") : t("尚未配置提醒", "Notifications not configured")} · Codex ${status.codex_version || t("未发现", "not found")} (${configurationLabel("codex")}) · Claude ${status.claude_version || t("未发现", "not found")} (${configurationLabel("claude")})${status.notes.filter(note => !note.startsWith("Codex: use") && !note.startsWith("Existing sessions")).map(note => ` ${note}`).join("")}`);
    } catch (error) { if (request === setupRequest.current) setSetup(error instanceof Error ? error.message : String(error)); }
    finally { if (request === setupRequest.current) setBusy(false); }
  }, [sessionId, t]);
  React.useEffect(() => {
    ++setupRequest.current; setSetup(""); setRuntime(null); setConfigured(false); setBusy(false);
  }, [sessionId]);
  React.useEffect(() => {
    if (opened && sessionId) void configure("status");
  }, [opened, sessionId, configure]);
  const value = React.useMemo(() => ({ events, preferences, ready, connected, open, update, enable, preview }), [events, preferences, ready, connected, open, update, enable, preview]);
  return <NotificationContext.Provider value={value}>
    {children}
    {user && toast && !opened && <div role="status" className="fixed bottom-16 right-4 z-[60] flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-lg border border-line bg-surface p-3 text-sm text-ink shadow-lg">
      <button type="button" className="min-w-0 text-left" onClick={() => visit(toast)}><span className="block truncate font-medium">{toast.session_name} · {toast.app === "terminal" ? "Terminal" : toast.app === "codex" ? "Codex" : "Claude"}</span><span className="text-ink-soft">{label(toast)}</span></button>
      <Button variant="ghost" size="icon" aria-label={t("关闭提醒", "Dismiss notification")} onClick={() => setToast(null)}><X size={16} /></Button>
    </div>}
    {user && opened && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 p-4" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="notification-title" className="flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-surface p-4 text-ink shadow-xl" onKeyDown={event => {
        if (event.key !== "Tab") return;
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]'));
        const target = event.shiftKey ? items.at(-1) : items[0];
        if (document.activeElement === (event.shiftKey ? items[0] : items.at(-1))) { event.preventDefault(); target?.focus(); }
      }}>
        <div className="mb-3 flex items-center justify-between"><h2 id="notification-title" className="font-semibold">{t("任务提醒与声音", "Task notifications and sound")}</h2><Button autoFocus variant="ghost" size="icon" onClick={close} aria-label={t("关闭声音设置", "Close notification settings")}><X size={18} /></Button></div>
        <div className="overflow-y-auto space-y-4">
          <div className="flex flex-wrap items-center gap-2"><Button onClick={() => void enable()}><Volume2 size={16} />{ready ? t("试听并开启声音", "Preview and enable sound") : t("开启声音并试听", "Enable sound and preview")}</Button><span className="text-xs text-ink-soft">{preferences.enabled ? ready ? t("声音已就绪", "Sound ready") : t("点击按钮启用本页声音", "Click to activate sound on this page") : t("声音已关闭", "Sound off")} · {connected ? t("通知已连接", "Notifications connected") : t("通知未连接", "Notifications disconnected")}</span></div>
          {audioError && <p role="status" className="text-sm text-warn">{t("浏览器尚未允许播放声音，请检查网站的声音权限后重试。", "The browser has not allowed sound. Check this site's sound permission and retry.")}</p>}
          <div className="grid gap-2 text-sm">
            {([
              ["enabled", t("播放提示音", "Play notification sounds")], ["complete", t("本轮结束提示音", "Turn finished sound")],
              ["attention", t("提问与批准提示音", "Question and approval sound")], ["bell", t("通用终端响铃", "Generic terminal bell")],
              ["backgroundOnly", t("仅离开当前网页时响铃", "Only sound when away from this page")],
            ] as const).map(([key, text]) => <label key={key} className="flex items-center gap-2"><input type="checkbox" checked={preferences[key]} onChange={event => update({ [key]: event.target.checked })} />{text}</label>)}
            <label className="flex items-center gap-3">{t("音量", "Volume")} <input aria-label={t("提示音音量", "Notification volume")} className="flex-1" type="range" min="0" max="100" value={Math.round(preferences.volume * 100)} onChange={event => update({ volume: Number(event.target.value) / 100 })} /><span>{Math.round(preferences.volume * 100)}%</span></label>
            <div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => void preview(false)}>{t("试听完成音", "Preview completion")}</Button><Button size="sm" variant="secondary" onClick={() => void preview(true)}>{t("试听提问音", "Preview attention")}</Button><Button size="sm" variant="ghost" onClick={() => update({ volume: DEFAULT_SOUND.volume })}>{t("使用推荐音量 60%", "Use recommended volume: 60%")}</Button></div>
          </div>
          {sessionId && <div className="space-y-2 rounded-lg border border-line p-3 text-sm"><p>{t("当前服务器的 CLI 提醒", "CLI notifications on this server")}</p><p className="text-xs text-ink-soft">{t("接入会为当前 SSH 用户配置 Codex 通知及 Claude Hook，保留已有配置并保存备份。声音和音量仅影响当前设备。", "Configure Codex notifications and Claude hooks for this SSH user, preserving existing settings and keeping backups. Sound preferences apply to this device.")}</p><div className="flex flex-wrap gap-2"><Button size="sm" loading={busy} onClick={() => void configure("install")}>{t("接入 CLI 提醒", "Configure CLI notifications")}</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => void configure("status")}>{t("检查接入", "Check setup")}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void configure("uninstall")}>{t("撤销接入", "Remove setup")}</Button></div></div>}
          {setup && <p role="status" className="break-words text-xs text-ink-soft">{setup}</p>}
          {sessionId && runtime && <NotificationRuntimeStatus runtime={runtime} configured={configured} busy={busy} bind={id => void configure("bind", id)} t={t} />}
          <p className="text-xs text-ink-soft">{t("网页保持打开时接收提醒；浏览器休眠、设备锁屏或网页关闭后不保证即时播放。旧通知和重连回放不会补响。", "Keep the page open for alerts. Sleeping browsers, locked devices and closed pages may not play sounds promptly. Old notifications and reconnect history stay silent.")}</p>
          <div className="border-t border-line pt-3"><h3 className="mb-2 text-sm font-medium">{t("最近提醒", "Recent notifications")} ({events.filter(event => !event.read_at).length} {t("未读", "unread")})</h3>
            {!events.length && <p className="text-sm text-ink-soft">{t("暂无提醒", "No notifications yet")}</p>}
            <div className="space-y-1">{events.slice(0, 50).map(event => <button key={event.id} type="button" onClick={() => visit(event)} className="block w-full rounded p-2 text-left text-sm hover:bg-elevated"><span className="block truncate">{!event.read_at && <Circle size={6} fill="currentColor" className="mr-2 inline-block text-brand" aria-label={t("未读", "Unread")} />}{event.session_name} · {event.app}</span><span className="text-ink-soft">{label(event)} · {new Date(event.created_at).toLocaleTimeString()}</span></button>)}</div>
          </div>
        </div>
      </div>
    </div>}
  </NotificationContext.Provider>;
}

export function NotificationButton() {
  const context = React.useContext(NotificationContext);
  const language = React.useContext(AppContext)?.language;
  if (!context) return null;
  const count = context.events.filter(event => !event.read_at).length;
  return <Button variant="ghost" size="sm" onClick={context.open} aria-label={language === "en-US" ? "Task notifications and sound" : "任务提醒与声音"} title={language === "en-US" ? "Task notifications and sound" : "任务提醒与声音"}>
    <span aria-hidden="true" className="pointer-events-none relative inline-flex">
      {context.preferences.enabled ? context.ready ? <Bell size={16} /> : <Volume2 size={16} /> : <VolumeX size={16} />}
      {count > 0 && <span className="notification-unread-dot absolute -right-1 -top-1 h-2 w-2 rounded-full bg-brand ring-2 ring-surface" />}
    </span>
    {count > 0 && <span className="sr-only">{language === "en-US" ? `${count} unread notifications` : `${count} 条未读提醒`}</span>}
  </Button>;
}

export function NotificationSessionBadge({ sessionId }: { sessionId: string }) {
  const context = React.useContext(NotificationContext);
  const language = React.useContext(AppContext)?.language;
  const latest = context?.events.find(event => event.session_id === sessionId && !event.read_at);
  if (!latest || !context) return null;
  const attention = soundPriority(latest.kind) === 2;
  return <button type="button" onClick={context.open} className="notification-status rounded border border-brand/30 bg-brand/10 px-2 py-0.5 text-xs text-brand" title={new Date(latest.created_at).toLocaleString()}>
    {language === "en-US" ? attention ? "Unread: needs attention" : "Unread notification" : attention ? "未读：需要处理" : "有未读提醒"}
  </button>;
}
