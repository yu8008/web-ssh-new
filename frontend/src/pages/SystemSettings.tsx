import React from "react";
import { PageFrame } from "../components/PageFrame";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Input } from "../components/Input";
import { ClipboardImageCache } from "../components/ClipboardImageCache";
import { useToast } from "../components/ToastContext";
import { useApp } from "../context/AppContextCore";
import { updateSystemSettings } from "../lib/api";
import { getTerminalScrollback, saveTerminalScrollback, TERMINAL_SCROLLBACK_CHOICES } from "./terminal/terminalPreferences";

const DEFAULT_RETRY_SCHEDULE_SECONDS = [2, 4, 8, 16, 32];

function localizeText(language: string, zh: string, en: string): string {
  return language === "en-US" ? en : zh;
}

function resizeRetrySchedule(values: string[], attemptCount: number): string[] {
  const normalizedCount = Math.max(1, attemptCount);
  const next = values.slice(0, normalizedCount);
  const defaultTail = String(DEFAULT_RETRY_SCHEDULE_SECONDS[DEFAULT_RETRY_SCHEDULE_SECONDS.length - 1]);

  while (next.length < normalizedCount) {
    const defaultValue = DEFAULT_RETRY_SCHEDULE_SECONDS[next.length];
    const fallbackValue = next[next.length - 1] || defaultTail;
    next.push(String(defaultValue ?? fallbackValue));
  }

  return next;
}

function buildRetryScheduleValues(attemptCount: number, scheduleSeconds: number[]): string[] {
  const values = scheduleSeconds.length > 0 ? scheduleSeconds.map((value) => String(value)) : [];
  return resizeRetrySchedule(values, attemptCount);
}

export function SystemSettingsPage() {
  const {
    isDark,
    language,
    systemSettings,
    systemSettingsLoading,
    applySystemSettings,
  } = useApp();
  const { push } = useToast();
  const t = React.useCallback((zh: string, en: string) => localizeText(language, zh, en), [language]);
  const [form, setForm] = React.useState({
    enhancedRetryMaxAttempts: "5",
    enhancedRetryScheduleSeconds: buildRetryScheduleValues(5, DEFAULT_RETRY_SCHEDULE_SECONDS),
    showSessionStatusSummary: true,
    sessionStatusRefreshIntervalSeconds: "3",
    defaultEnableEnhancedSession: false,
    clipboardImageRetentionDays: 3 as 3 | 7,
  });
  const [saving, setSaving] = React.useState(false);
  const [terminalScrollback, setTerminalScrollback] = React.useState(getTerminalScrollback);

  React.useEffect(() => {
    if (!systemSettings) {
      return;
    }
    setForm({
      enhancedRetryMaxAttempts: String(systemSettings.enhanced_retry_max_attempts),
      enhancedRetryScheduleSeconds: buildRetryScheduleValues(
        systemSettings.enhanced_retry_max_attempts,
        systemSettings.enhanced_retry_schedule_seconds,
      ),
      showSessionStatusSummary: systemSettings.show_session_status_summary,
      sessionStatusRefreshIntervalSeconds: String(systemSettings.session_status_refresh_interval_seconds),
      defaultEnableEnhancedSession: systemSettings.default_enable_enhanced_session,
      clipboardImageRetentionDays: systemSettings.clipboard_image_retention_days ?? 3,
    });
  }, [systemSettings]);

  const handleRetryAttemptsChange = (value: string) => {
    setForm((prev) => {
      if (value === "") {
        return { ...prev, enhancedRetryMaxAttempts: value };
      }

      const attemptCount = Number(value);
      if (!Number.isInteger(attemptCount) || attemptCount < 1) {
        return { ...prev, enhancedRetryMaxAttempts: value };
      }

      return {
        ...prev,
        enhancedRetryMaxAttempts: value,
        enhancedRetryScheduleSeconds: resizeRetrySchedule(prev.enhancedRetryScheduleSeconds, attemptCount),
      };
    });
  };

  const handleRetryScheduleChange = (index: number, value: string) => {
    setForm((prev) => {
      const next = [...prev.enhancedRetryScheduleSeconds];
      next[index] = value;
      return { ...prev, enhancedRetryScheduleSeconds: next };
    });
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();

    const enhancedRetryMaxAttempts = Number(form.enhancedRetryMaxAttempts);
    const sessionStatusRefreshIntervalSeconds = Number(form.sessionStatusRefreshIntervalSeconds);
    const enhancedRetryScheduleSeconds = form.enhancedRetryScheduleSeconds.map((value) => Number(value));

    if (!Number.isInteger(enhancedRetryMaxAttempts) || enhancedRetryMaxAttempts < 1) {
      push(t("增强会话自动重试次数必须是大于 0 的整数", "Enhanced retry attempts must be a positive integer."));
      return;
    }
    if (!Number.isInteger(sessionStatusRefreshIntervalSeconds) || sessionStatusRefreshIntervalSeconds < 1) {
      push(t("会话系统状态刷新间隔必须是大于 0 的整数秒", "System status refresh interval must be a positive integer."));
      return;
    }
    if (enhancedRetryScheduleSeconds.length !== enhancedRetryMaxAttempts) {
      push(t("每次自动重试都必须配置一个对应的等待间隔", "Each retry attempt must have a matching delay."));
      return;
    }
    if (enhancedRetryScheduleSeconds.some((value) => !Number.isInteger(value) || value < 1)) {
      push(t("每次自动重试的等待间隔都必须是大于 0 的整数秒", "Each retry delay must be a positive integer."));
      return;
    }

    setSaving(true);
    try {
      const saved = await updateSystemSettings({
        enhanced_retry_max_attempts: enhancedRetryMaxAttempts,
        enhanced_retry_schedule_seconds: enhancedRetryScheduleSeconds,
        show_session_status_summary: form.showSessionStatusSummary,
        session_status_refresh_interval_seconds: sessionStatusRefreshIntervalSeconds,
        default_enable_enhanced_session: form.defaultEnableEnhancedSession,
        clipboard_image_retention_days: form.clipboardImageRetentionDays,
      });
      applySystemSettings(saved);
      saveTerminalScrollback(terminalScrollback);
      push(t("系统设置已保存并应用", "System settings saved and applied."));
    } catch (error) {
      push(error instanceof Error ? error.message : t("保存系统设置失败", "Failed to save system settings."));
    } finally {
      setSaving(false);
    }
  };

  const retryAttemptCount = Number(form.enhancedRetryMaxAttempts);
  const canRenderRetrySchedule = Number.isInteger(retryAttemptCount) && retryAttemptCount >= 1;
  const sectionClassName = isDark ? "border-line bg-canvas/40" : "border-line bg-elevated";
  const hintClassName = isDark ? "text-muted" : "text-muted";
  const subtleClassName = isDark ? "text-muted" : "text-muted";

  return (
    <PageFrame title={t("系统设置", "System settings")} description={t("让每一个细节，都按你的方式运行。", "Make every detail work your way.")} index="03">
        <Card
          title={t("全局运行设置", "Global Runtime Settings")}
          description={t("这里只包含当前已支持页面化管理且可即时生效的系统级参数。", "This page only includes system-wide settings that are currently supported for immediate runtime updates.")}
          className={!isDark ? "bg-surface border-line shadow-sm" : ""}
          titleClassName={!isDark ? "text-ink" : ""}
          descClassName={!isDark ? "text-muted" : ""}
        >
          {systemSettingsLoading && !systemSettings ? (
            <div className={`text-sm ${isDark ? "text-muted" : "text-muted"}`}>{t("加载系统设置中...", "Loading system settings...")}</div>
          ) : (
            <form className="space-y-5" onSubmit={handleSave}>
              <div className={`rounded-xl border p-4 ${sectionClassName}`}>
                <label htmlFor="clipboard-retention" className="text-sm font-medium">
                  {t("粘贴图片自动清理", "Pasted image cleanup")}
                </label>
                <select
                  id="clipboard-retention"
                  value={form.clipboardImageRetentionDays}
                  onChange={(event) => setForm((prev) => ({ ...prev, clipboardImageRetentionDays: Number(event.target.value) as 3 | 7 }))}
                  className={`mt-2 block w-full rounded-md border px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ${sectionClassName}`}
                >
                  <option value={3}>{t("保留 3 天", "Keep for 3 days")}</option>
                  <option value={7}>{t("保留 7 天", "Keep for 7 days")}</option>
                </select>
                <p className={`mt-2 text-xs ${hintClassName}`}>
                  {t("默认保留 3 天，可改为 7 天。后台每小时检查并删除过期图片；目标离线时下次重试，无需保持终端打开。需要长期保留的图片请先下载。", "Defaults to 3 days, with a 7-day option. Expired images are checked hourly, including when terminals are closed. Offline targets are retried later. Download images you want to keep.")}
                </p>
                <a href="#clipboard-image-cache" className="mt-2 inline-block text-xs text-brand underline">
                  {t("查看和管理缓存图片", "View and manage cached images")}
                </a>
              </div>
              <div className={`rounded-xl border p-4 ${sectionClassName}`}>
                <label htmlFor="terminal-scrollback" className="text-sm font-medium">
                  {t("终端历史保留行数", "Terminal scrollback lines")}
                </label>
                <select
                  id="terminal-scrollback"
                  value={terminalScrollback}
                  onChange={(event) => setTerminalScrollback(Number(event.target.value))}
                  className={`mt-2 block w-full rounded-md border px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ${sectionClassName}`}
                >
                  {TERMINAL_SCROLLBACK_CHOICES.map((lines) => (
                    <option key={lines} value={lines}>{lines.toLocaleString()} {t("行", "lines")}</option>
                  ))}
                </select>
                <p className={`mt-2 text-xs ${hintClassName}`}>
                  {t("默认保留 10,000 行。更多历史会占用更多内存。此设置保存在当前浏览器，保存后重新打开终端生效。", "Defaults to 10,000 lines. More history uses more memory. Saved in this browser and applied when reopening a terminal.")}
                </p>
              </div>
              <div className={`rounded-xl border p-4 ${sectionClassName}`}>
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">{t("会话系统状态展示", "Session Status Display")}</h3>
                  <p className={`text-xs ${hintClassName}`}>
                    {t("关闭后，会话管理页将不再展示 CPU、内存、交换区和网络速率，也不会继续发起相关轮询。", "When disabled, session management stops showing CPU, memory, swap, and network throughput, and no further polling is triggered.")}
                  </p>
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-[1.5fr,1fr]">
                  <label className={`flex items-start gap-3 rounded-lg border p-4 ${sectionClassName}`}>
                    <input
                      type="checkbox"
                      checked={form.showSessionStatusSummary}
                      onChange={(event) => setForm((prev) => ({ ...prev, showSessionStatusSummary: event.target.checked }))}
                      className="mt-1 h-4 w-4 rounded border-line-strong text-brand focus:ring-brand"
                    />
                    <span className="space-y-1">
                      <span className="block text-sm font-medium">{t("是否开启会话管理页面系统状态展示", "Enable system status display on session management")}</span>
                      <span className={`block text-xs ${hintClassName}`}>
                        {t("该项控制会话卡片中系统状态模块是否显示。", "Controls whether the session cards display system status blocks.")}
                      </span>
                    </span>
                  </label>

                  <div className={`rounded-lg border p-4 ${sectionClassName}`}>
                    <label className="text-sm font-medium">{t("会话系统状态刷新间隔（秒）", "Session status refresh interval (seconds)")}</label>
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={form.sessionStatusRefreshIntervalSeconds}
                      onChange={(event) => setForm((prev) => ({ ...prev, sessionStatusRefreshIntervalSeconds: event.target.value }))}
                      disabled={!form.showSessionStatusSummary}
                      className={`mt-2 ${!isDark ? "border-line-strong bg-surface text-ink placeholder:text-muted" : ""} ${!form.showSessionStatusSummary ? "opacity-60" : ""}`}
                    />
                    <p className={`mt-2 text-xs ${hintClassName}`}>
                      {t("仅在开启展示时生效，默认每 3 秒更新一次。", "Only applies when display is enabled. Default refresh is every 3 seconds.")}
                    </p>
                  </div>
                </div>
              </div>

              <div className={`rounded-xl border p-4 ${sectionClassName}`}>
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">{t("增强会话自动重试策略", "Enhanced Session Retry Strategy")}</h3>
                  <p className={`text-xs ${hintClassName}`}>
                    {t("重试次数与每次等待间隔一一对应。系统会严格按下列顺序执行，避免出现“次数更多但没有对应间隔”的歧义。", "Each retry attempt maps to one delay value in order, avoiding ambiguous configurations with missing intervals.")}
                  </p>
                </div>

                <div className="mt-4 space-y-4">
                  <div className="max-w-xs space-y-2">
                    <label className="text-sm font-medium">{t("增强会话自动重试最大次数", "Enhanced retry max attempts")}</label>
                    <Input
                      type="number"
                      min={1}
                      max={20}
                      value={form.enhancedRetryMaxAttempts}
                      onChange={(event) => handleRetryAttemptsChange(event.target.value)}
                      className={!isDark ? "border-line-strong bg-surface text-ink placeholder:text-muted" : ""}
                    />
                    <p className={`text-xs ${subtleClassName}`}>
                      {t("修改次数后，下方会自动同步对应数量的间隔输入项。", "Changing the attempt count automatically syncs the delay inputs below.")}
                    </p>
                  </div>

                  {canRenderRetrySchedule ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      {form.enhancedRetryScheduleSeconds.map((value, index) => (
                        <div key={`retry-delay-${index}`} className={`rounded-lg border p-4 ${sectionClassName}`}>
                          <label className="text-sm font-medium">
                            {t(`第 ${index + 1} 次自动重试等待（秒）`, `Delay before retry ${index + 1} (seconds)`)}
                          </label>
                          <Input
                            type="number"
                            min={1}
                            max={3600}
                            value={value}
                            onChange={(event) => handleRetryScheduleChange(index, event.target.value)}
                            className={`mt-2 ${!isDark ? "border-line-strong bg-surface text-ink placeholder:text-muted" : ""}`}
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className={`rounded-lg border px-4 py-3 text-sm ${sectionClassName}`}>
                      {t("请先填写有效的自动重试次数。", "Enter a valid retry attempt count first.")}
                    </div>
                  )}
                </div>
              </div>

              <div className={`rounded-xl border p-4 ${sectionClassName}`}>
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={form.defaultEnableEnhancedSession}
                    onChange={(event) => setForm((prev) => ({ ...prev, defaultEnableEnhancedSession: event.target.checked }))}
                    className="mt-1 h-4 w-4 rounded border-line-strong text-brand focus:ring-brand"
                  />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium">{t("系统支持时默认开启增强持久化连接", "Enable enhanced persistence by default when supported")}</span>
                    <span className={`block text-xs ${hintClassName}`}>
                      {t("开启后，用户创建新会话时如果目标系统支持增强持久化连接，将直接按增强模式创建，不再弹出询问框。", "When enabled, supported targets create new sessions directly in enhanced mode without showing the confirmation dialog.")}
                    </span>
                  </span>
                </label>
              </div>

              <div className="flex flex-wrap justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  lightMode={!isDark}
                  onClick={() => {
                    window.location.href = "/sessions";
                  }}
                  disabled={saving}
                >
                  {t("返回", "Back")}
                </Button>
                <Button type="submit" lightMode={!isDark} loading={saving}>
                  {t("保存并应用", "Save and Apply")}
                </Button>
              </div>
            </form>
          )}
        </Card>
        <section id="clipboard-image-cache" className="scroll-mt-6">
          <ClipboardImageCache />
        </section>
    </PageFrame>
  );
}
