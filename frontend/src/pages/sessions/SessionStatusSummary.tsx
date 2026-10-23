import React from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "../../lib/utils";
import type { SessionStatusEntry } from "./useSessionStatusSummary";
import { formatBytesPerSecond } from "./sessionsUtils";

type SessionStatusSummaryProps = {
  entry?: SessionStatusEntry;
  isDark: boolean;
  t: (zh: string, en: string) => string;
};

type MetricCardProps = {
  label: string;
  value: string;
  percent?: number;
  isDark: boolean;
  accentClassName: string;
  muted?: boolean;
};

function MetricCard({ label, value, percent, isDark, accentClassName, muted = false }: MetricCardProps) {
  return (
    <div
      className={`rounded-md border px-3 py-2 ${
        isDark ? "border-line bg-canvas/60" : "border-line bg-elevated"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className={`text-xs font-medium ${isDark ? "text-muted" : "text-muted"}`}>
          {label}
        </span>
        <span className={cn("text-sm font-semibold", muted ? (isDark ? "text-muted" : "text-muted") : "")}>
          {value}
        </span>
      </div>
      {typeof percent === "number" ? (
        <div className={`mt-2 h-1.5 rounded-full ${isDark ? "bg-elevated" : "bg-line"}`}>
          <div
            className={`h-1.5 rounded-full transition-all duration-300 ${accentClassName}`}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
      ) : (
        <div className={`mt-2 h-1.5 rounded-full ${isDark ? "bg-elevated" : "bg-line"}`} />
      )}
    </div>
  );
}

export function SessionStatusSummary({ entry, isDark, t }: SessionStatusSummaryProps) {
  if (!entry || (entry.loading && !entry.summary)) {
    return (
      <div className={`rounded-md border px-3 py-3 text-sm ${isDark ? "border-line bg-canvas/40 text-muted" : "border-line bg-elevated text-muted"}`}>
        {t("系统状态采集中...", "Loading system status...")}
      </div>
    );
  }

  if (!entry.summary) {
    return (
      <div className={`rounded-md border px-3 py-3 text-sm ${isDark ? "border-line bg-canvas/40 text-muted" : "border-line bg-elevated text-muted"}`}>
        {t("系统状态暂不可用", "System status unavailable")}
      </div>
    );
  }

  const { stats, network } = entry.summary;
  const swapEnabled = stats.swap.total > 0;

  return (
    <div className={`rounded-lg border p-3 ${isDark ? "border-line bg-canvas/30" : "border-line bg-elevated/80"}`}>
      <div className="grid gap-2 md:grid-cols-3">
        <MetricCard
          label="CPU"
          value={`${stats.cpu.percent.toFixed(1)}%`}
          percent={stats.cpu.percent}
          isDark={isDark}
          accentClassName="bg-sky-500"
        />
        <MetricCard
          label={t("内存", "Memory")}
          value={`${stats.memory.percent.toFixed(1)}%`}
          percent={stats.memory.percent}
          isDark={isDark}
          accentClassName="bg-emerald-500"
        />
        <MetricCard
          label={t("交换区", "Swap")}
          value={swapEnabled ? `${stats.swap.percent.toFixed(1)}%` : t("未启用", "Disabled")}
          percent={swapEnabled ? stats.swap.percent : undefined}
          isDark={isDark}
          accentClassName="bg-amber-500"
          muted={!swapEnabled}
        />
        <div className={`rounded-md border px-3 py-2 md:col-span-3 ${isDark ? "border-line bg-canvas/60" : "border-line bg-surface"}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className={`text-xs font-medium ${isDark ? "text-muted" : "text-muted"}`}>
              {t("网络", "Network")}
            </span>
            <div className="flex flex-wrap items-center gap-4 text-sm font-medium">
              <span className={isDark ? "text-emerald-300" : "text-emerald-600"}>
                <ArrowUp size={11} className="mr-1 inline-block" aria-hidden="true" />{formatBytesPerSecond(network.upload_speed)}
              </span>
              <span className={isDark ? "text-sky-300" : "text-sky-600"}>
                <ArrowDown size={11} className="mr-1 inline-block" aria-hidden="true" />{formatBytesPerSecond(network.download_speed)}
              </span>
            </div>
          </div>
        </div>
      </div>
      {entry.error ? (
        <p className={`mt-2 text-[11px] ${isDark ? "text-muted" : "text-muted"}`}>
          {t("本次刷新失败，当前显示上次采集结果", "Refresh failed. Showing the previous result.")}
        </p>
      ) : null}
    </div>
  );
}
