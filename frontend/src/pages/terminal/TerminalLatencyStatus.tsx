import React from "react";
import { X } from "lucide-react";
import type { TerminalDiagnostics } from "./terminalDiagnostics";

type Props = {
  terminalLatencyMs: number | null;
  browserLatencyMs: number | null;
  targetLatencyMs: number | null;
  terminalDiagnostics: TerminalDiagnostics | null;
  t: (zh: string, en: string) => string;
};

export function TerminalLatencyStatus({ terminalLatencyMs, browserLatencyMs, targetLatencyMs, terminalDiagnostics: details, t }: Props) {
  const [open, setOpen] = React.useState(false);
  const button = React.useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); button.current?.focus(); };
  React.useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); button.current?.focus(); } };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open]);
  const ms = (value: number | null | undefined) => value === null || value === undefined ? "—" : `${Math.round(value)}ms`;
  const rows = [
    [t("浏览器 ↔ 网关", "Browser ↔ gateway"), ms(terminalLatencyMs)],
    [t("网关 ↔ SSH 目标", "Gateway ↔ SSH target"), ms(targetLatencyMs)],
    [t("网关回包排队", "Gateway reply queue"), ms(details?.gatewayQueueMs)],
    [t("网关调度迟到（近 5 秒最大）", "Gateway scheduling delay (5s max)"), ms(details?.gatewayLagMs)],
    [t("浏览器调度迟到（近 5 秒最大）", "Browser scheduling delay (5s max)"), ms(details?.browserLagMs)],
    [t("当前输出处理等待", "Current output processing wait"), ms(details?.outputWaitMs)],
    [t("最近一批输出处理", "Last output processing"), ms(details?.outputParseMs)],
    [t("解析后等待绘制", "Wait for render after parsing"), ms(details?.renderWaitMs)],
    [t("浏览器待处理输出", "Browser output backlog"), details ? `${details.outputQueuedChars.toLocaleString()} ${t("字符", "chars")}` : "—"],
    [t("网关待发送输出", "Gateway output backlog"), details?.gatewayQueuedChars === undefined ? "—" : `${details.gatewayQueuedChars.toLocaleString()} ${t("字符", "chars")}`],
    [t("HTTP 健康检查", "HTTP health check"), ms(browserLatencyMs)],
  ];
  return <>
    <button ref={button} type="button" onClick={() => setOpen(true)} aria-label={t("延迟诊断", "Latency details")} aria-haspopup="dialog"
      className="rounded px-1 py-0.5 font-medium tabular-nums text-ink-soft hover:bg-elevated hover:text-ink" title={t("点击查看浏览器到网关、SSH 及处理排队耗时", "View browser/gateway, SSH and processing delays")}>
      {terminalLatencyMs !== null ? `${t("网关", "Gateway")} ${terminalLatencyMs}ms` : browserLatencyMs !== null ? `${t("网页", "Web")} ${browserLatencyMs}ms` : t("延迟", "Latency")}
    </button>
    {targetLatencyMs !== null ? <span className="font-medium tabular-nums text-ink-soft" title={t("网关服务器到 SSH 目标的命令往返时间", "Command round trip from the gateway server to the SSH target")}>SSH {targetLatencyMs}ms</span> : null}
    {open ? <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div role="dialog" aria-modal="true" aria-label={t("延迟诊断", "Latency details")} className="max-h-[90dvh] w-full max-w-lg overflow-auto rounded-xl border border-line bg-surface p-4 text-sm text-ink shadow-panel"
        onKeyDown={event => { if (event.key === "Tab") { event.preventDefault(); event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus(); } }}>
        <div className="mb-3 flex items-center justify-between gap-3"><h2 className="font-semibold">{t("延迟诊断", "Latency details")}</h2>
          <button type="button" autoFocus onClick={close} className="rounded p-1 hover:bg-elevated" aria-label={t("关闭延迟诊断", "Close latency details")}><X className="h-4 w-4" /></button>
        </div>
        <table className="w-full text-left text-xs"><tbody>{rows.map(([label, value]) => <tr key={label} className="border-b border-line last:border-0">
          <th scope="row" className="py-2 pr-3 font-normal text-ink-soft">{label}</th><td className="py-2 text-right font-mono tabular-nums">{value}</td>
        </tr>)}</tbody></table>
        <p className="mt-3 text-xs leading-relaxed text-muted">{t("网关往返包含网络及两端消息调度，不经过 SSH。调度迟到和输出等待是独立采样，不能直接从往返时间中相减；“—”表示尚无数据。", "Gateway round trip includes networking and scheduling at both ends, without SSH. Scheduling and output wait are independent samples, not values to subtract from the round trip. “—” means unavailable.")}</p>
      </div>
    </div> : null}
  </>;
}
