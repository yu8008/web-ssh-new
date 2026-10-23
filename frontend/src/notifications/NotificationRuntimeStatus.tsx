import { Button } from "../components/Button";
import type { CliRuntime } from "./notificationRuntime";

export function NotificationRuntimeStatus({ runtime, configured, busy, bind, t }: {
  runtime: CliRuntime; configured: boolean; busy: boolean;
  bind: (id: string) => void; t: (zh: string, en: string) => string;
}) {
  const states: Record<string, string> = {
    pending: t("正在检查当前会话", "Checking the current session"),
    not_configured: t("接入提醒后，开始验证当前运行中的会话", "Configure notifications to verify the running session"),
    observing: t("已发现运行中的 CLI，等待实际事件验证", "Running CLI found; waiting to verify an event"),
    attached: t("已连接现有会话记录，无需重启 CLI", "Attached to the existing session record; no CLI restart needed"),
    binding_required: t("共享进程中有会话记录，请确认当前使用的会话", "Confirm the current session record from the shared process"),
    record_unavailable: t("未找到可绑定的会话记录，等待原生通知验证", "No bindable session record found; waiting for a native notification"),
    not_found: t("当前终端未发现运行中的 Codex 或 Claude", "No running Codex or Claude found in this terminal"),
    ambiguous_process: t("当前终端有多个 CLI 进程，暂未绑定", "Multiple CLI processes found in this terminal; not bound yet"),
    unavailable: t("当前环境无法检查运行中的 CLI", "Cannot inspect running CLIs in this environment"),
    disconnected: t("兼容监听未连接，请检查接入", "Compatibility observer disconnected; check setup"),
  };
  const status = (name: string) => runtime.capabilities[name] === "verified" ? t("已验证", "Verified") : runtime.capabilities[name] === "ready" ? t("已连接，待验证", "Connected; awaiting verification") : t("待验证", "Awaiting verification");
  return <div className="space-y-2 text-xs" aria-label={t("当前 CLI 接入状态", "Current CLI integration status")}>
    {runtime.app && <p>{t("正在运行", "Running")}: {runtime.app === "codex" ? "Codex" : "Claude Code"}{runtime.cwd && <span className="break-all text-ink-soft"> · {runtime.cwd}</span>}</p>}
    <p>{states[runtime.state] ?? t("等待检查", "Awaiting inspection")}</p>
    {runtime.app && <p className="text-ink-soft">{t("完成", "Completion")}: {status("complete")} · {runtime.capabilities.attention === "verified" ? t("等待用户处理：已验证通用提醒", "Waiting for user: generic notification verified") : `${t("提问", "Question")}: ${status("question")} · ${t("批准", "Approval")}: ${status("approval")}`}</p>}
    {configured && runtime.state === "binding_required" && runtime.candidates.map(item => <div key={item.id} className="flex items-center gap-2 rounded border border-line p-2">
      <div className="min-w-0 flex-1">{item.title && <p className="break-words">{item.title}</p>}<p className="break-all">{item.cwd}</p><p className="break-all text-ink-soft">{item.id} · {new Date(item.modified_at * 1000).toLocaleString()}</p></div>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => bind(item.id)}>{t("绑定此会话", "Bind this session")}</Button>
    </div>)}
  </div>;
}
