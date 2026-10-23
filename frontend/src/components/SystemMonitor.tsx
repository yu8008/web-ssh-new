import React from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { getSystemOverview, SystemStats, NetworkInfo, ProcessInfo, DiskInfo } from "../lib/api";
import { useApp } from "../context/AppContextCore";
import type { NetworkProfile } from "../context/AppContextCore";

function localizeText(language: string, zh: string, en: string): string {
  return language === "en-US" ? en : zh;
}

type SortField = "cpu" | "memory";
type SortOrder = "asc" | "desc";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec === 0) return "0 B/s";
  const k = 1024;
  const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
  return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

type ProgressBarProps = {
  percent: number;
  isDark: boolean;
  label: string;
  color?: "blue" | "green" | "yellow" | "red" | "cyan" | "purple";
};

function ProgressBar({ percent, isDark, label, color = "blue" }: ProgressBarProps) {
  const clampedPercent = Math.min(100, Math.max(0, percent));
  const colorClasses = {
    blue: "bg-blue-500",
    green: "bg-emerald-500",
    yellow: "bg-amber-500",
    red: "bg-rose-500",
    cyan: "bg-cyan-500",
    purple: "bg-purple-500",
  };

  const getColor = () => {
    if (percent >= 90) return colorClasses.red;
    if (percent >= 70) return colorClasses.yellow;
    if (percent >= 50) return colorClasses.green;
    return colorClasses[color];
  };

  return (
    <div
      className={`h-2 w-full rounded-full ${isDark ? "bg-elevated" : "bg-line"}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Number(clampedPercent.toFixed(1))}
    >
      <div
        className={`h-2 rounded-full transition-all duration-300 ${getColor()}`}
        style={{ width: `${clampedPercent}%` }}
      />
    </div>
  );
}

type SystemMonitorProps = {
  sessionId: string;
  isDark: boolean;
  networkProfile?: NetworkProfile;
  compact?: boolean;
};

export function SystemMonitor({ sessionId, isDark, networkProfile, compact }: SystemMonitorProps) {
  const { networkProfile: globalNetworkProfile, language } = useApp();
  const t = React.useCallback((zh: string, en: string) => localizeText(language, zh, en), [language]);
  const effectiveNetworkProfile = networkProfile ?? globalNetworkProfile;
  const isCompact = compact === true;
  const [collapsedSections, setCollapsedSections] = React.useState({
    status: false,
    processes: isCompact,
    disks: isCompact,
  });
  const [stats, setStats] = React.useState<SystemStats | null>(null);
  const [network, setNetwork] = React.useState<NetworkInfo | null>(null);
  const [processes, setProcesses] = React.useState<ProcessInfo[]>([]);
  const [disks, setDisks] = React.useState<DiskInfo[]>([]);
  const [sortField, setSortField] = React.useState<SortField>("memory");
  const [sortOrder, setSortOrder] = React.useState<SortOrder>("desc");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const overviewInFlightRef = React.useRef(false);
  const metricsPollIntervalMs =
    effectiveNetworkProfile === "poor" ? 12000 : effectiveNetworkProfile === "degraded" ? 7000 : 3000;

  // 获取系统概览（CPU、内存、网络、进程、磁盘）
  const fetchOverview = React.useCallback(async () => {
    if (overviewInFlightRef.current) return;
    overviewInFlightRef.current = true;
    try {
      const overview = await getSystemOverview(sessionId);
      setStats(overview.stats);
      setNetwork(overview.network);
      setProcesses(overview.processes.processes);
      setDisks(overview.disks.disks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("获取数据失败", "Failed to fetch system data"));
    } finally {
      overviewInFlightRef.current = false;
      setLoading(false);
    }
  }, [sessionId, t]);

  // 系统监控轮询：改为单接口拉取并按网络质量动态降频
  React.useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const scheduleNext = () => {
      if (cancelled) return;
      timer = window.setTimeout(run, metricsPollIntervalMs);
    };

    const run = async () => {
      await fetchOverview();
      scheduleNext();
    };

    run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchOverview, metricsPollIntervalMs]);

  // 排序处理
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === "desc" ? "asc" : "desc");
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  };

  const sortedProcesses = React.useMemo(() => {
    const sorted = [...processes].sort((a, b) => {
      const aVal = sortField === "cpu" ? a.cpu_percent : a.memory_percent;
      const bVal = sortField === "cpu" ? b.cpu_percent : b.memory_percent;
      return sortOrder === "desc" ? bVal - aVal : aVal - bVal;
    });
    const maxCount = isCompact ? 3 : 5;
    return sorted.slice(0, maxCount);
  }, [processes, sortField, sortOrder, isCompact]);

  const toggleSection = React.useCallback((key: keyof typeof collapsedSections) => {
    setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const renderSectionHeader = (key: keyof typeof collapsedSections, title: string) => {
    if (!isCompact) {
      return (
        <h3 className={`text-sm font-semibold mb-3 ${isDark ? "text-ink" : "text-ink-soft"}`}>
          {title}
        </h3>
      );
    }
    return (
      <button
        type="button"
        onClick={() => toggleSection(key)}
        className={`w-full flex items-center justify-between text-sm font-semibold mb-2 ${
          isDark ? "text-ink" : "text-ink-soft"
        }`}
      >
        <span>{title}</span>
        <span className={`text-xs ${isDark ? "text-muted" : "text-muted"}`}>
          {collapsedSections[key] ? t("展开", "Expand") : t("收起", "Collapse")}
        </span>
      </button>
    );
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    const label = sortField !== field
      ? t("未排序", "Not sorted")
      : sortOrder === "desc"
      ? t("降序", "Descending")
      : t("升序", "Ascending");

    return (
      <>
        <span aria-hidden="true" className={sortField !== field ? "opacity-30" : ""}>
          {sortField !== field ? <ArrowUpDown size={11} /> : sortOrder === "desc" ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
        </span>
        <span className="sr-only">{label}</span>
      </>
    );
  };

  if (loading) {
    return (
        <div className={`text-xs ${isDark ? "text-muted" : "text-muted"}`}>
        {t("加载中...", "Loading...")}
      </div>
    );
  }

  if (error) {
    return (
      <div className={`text-xs ${isDark ? "text-rose-400" : "text-rose-500"}`}>
        {error}
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className={`system-monitor ${isCompact ? "space-y-3" : "space-y-4"}`}>
      <div>
        {renderSectionHeader("status", t("系统状态", "System Status"))}

        {!isCompact || !collapsedSections.status ? (
          <>
            {/* CPU */}
            <div className="mb-3">
              <div className="flex justify-between items-center mb-1">
                <span className={`text-xs ${isDark ? "text-muted" : "text-muted"}`}>
                  {t(`CPU (${stats.cpu.count} 核)`, `CPU (${stats.cpu.count} Cores)`)}
                </span>
                <span className={`text-xs font-medium ${isDark ? "text-ink-soft" : "text-ink-soft"}`}>
                  {stats.cpu.percent.toFixed(1)}%
                </span>
              </div>
              <ProgressBar
                percent={stats.cpu.percent}
                isDark={isDark}
                label={t(`CPU 使用率 ${stats.cpu.percent.toFixed(1)}%`, `CPU usage ${stats.cpu.percent.toFixed(1)}%`)}
                color="blue"
              />
            </div>

            {/* 内存 */}
            <div className="mb-3">
              <div className="flex justify-between items-center mb-1">
                <span className={`text-xs ${isDark ? "text-muted" : "text-muted"}`}>
                  {t("内存", "Memory")}
                </span>
                <span className={`text-xs font-medium ${isDark ? "text-ink-soft" : "text-ink-soft"}`}>
                  {stats.memory.percent.toFixed(1)}% ({formatBytes(stats.memory.used)} / {formatBytes(stats.memory.total)})
                </span>
              </div>
              <ProgressBar
                percent={stats.memory.percent}
                isDark={isDark}
                label={t(`内存使用率 ${stats.memory.percent.toFixed(1)}%`, `Memory usage ${stats.memory.percent.toFixed(1)}%`)}
                color="green"
              />
            </div>

            {/* 交换区 */}
            <div className="mb-3">
              <div className="flex justify-between items-center mb-1">
                <span className={`text-xs ${isDark ? "text-muted" : "text-muted"}`}>
                  {t("交换区", "Swap")}
                </span>
                <span className={`text-xs font-medium ${isDark ? "text-ink-soft" : "text-ink-soft"}`}>
                  {stats.swap.total > 0
                    ? `${stats.swap.percent.toFixed(1)}% (${formatBytes(stats.swap.used)} / ${formatBytes(stats.swap.total)})`
                    : t("未启用", "Disabled")
                  }
                </span>
              </div>
              {stats.swap.total > 0 && (
                <ProgressBar
                  percent={stats.swap.percent}
                  isDark={isDark}
                  label={t(`Swap 使用率 ${stats.swap.percent.toFixed(1)}%`, `Swap usage ${stats.swap.percent.toFixed(1)}%`)}
                  color="yellow"
                />
              )}
            </div>

            {/* 网络速度 */}
            <div className={`pt-3 mt-3 ${isDark ? "border-t border-line" : "border-t border-line"}`}>
              <div className="flex justify-between items-center">
                <span className={`text-xs ${isDark ? "text-muted" : "text-muted"}`}>
                  {t("网络", "Network")}
                </span>
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-medium ${isDark ? "text-purple-400" : "text-purple-600"}`}>
                    <ArrowUp size={11} className="mr-1 inline-block" aria-hidden="true" />{network ? formatSpeed(network.upload_speed) : "-"}
                  </span>
                  <span className={`text-xs font-medium ${isDark ? "text-cyan-400" : "text-cyan-600"}`}>
                    <ArrowDown size={11} className="mr-1 inline-block" aria-hidden="true" />{network ? formatSpeed(network.download_speed) : "-"}
                  </span>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>

      {/* 进程列表 */}
      <div className={`pt-4 ${isDark ? "border-t border-line" : "border-t border-line"}`}>
        {renderSectionHeader("processes", t("进程 TOP 5", "Top 5 Processes"))}

        {!isCompact || !collapsedSections.processes ? (
          <>
            {/* 表头 */}
            <div className={`flex text-xs mb-2 ${isDark ? "text-muted" : "text-muted"}`}>
              <div className="flex-1">{t("进程名", "Process")}</div>
              <button
                type="button"
                className="w-16 bg-transparent p-0 text-right hover:text-brand focus:outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-brand"
                onClick={() => handleSort("cpu")}
                aria-label={t("按 CPU 使用率排序", "Sort by CPU usage")}
                aria-pressed={sortField === "cpu"}
              >
                CPU <SortIcon field="cpu" />
              </button>
              <button
                type="button"
                className="w-20 bg-transparent p-0 text-right hover:text-brand focus:outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-brand"
                onClick={() => handleSort("memory")}
                aria-label={t("按内存使用量排序", "Sort by memory usage")}
                aria-pressed={sortField === "memory"}
              >
                {t("内存", "Memory")} <SortIcon field="memory" />
              </button>
            </div>

            {/* 进程表 */}
            <div className="space-y-1">
              {sortedProcesses.map((proc) => (
                <div
                  key={proc.pid}
                  className={`flex text-xs py-1 rounded px-1 ${isDark ? "hover:bg-elevated" : "hover:bg-elevated"} group relative`}
                  title={proc.command}
                >
                  <div className={`flex-1 truncate ${isDark ? "text-ink-soft" : "text-ink-soft"}`}>
                    {proc.name}
                  </div>
                  <div className={`w-16 text-right ${isDark ? "text-muted" : "text-muted"}`}>
                    {proc.cpu_percent.toFixed(1)}%
                  </div>
                  <div className={`w-20 text-right ${isDark ? "text-muted" : "text-muted"}`}>
                    {formatBytes(proc.memory_bytes)}
                  </div>
                </div>
              ))}
              {sortedProcesses.length === 0 && (
                <div className={`text-xs ${isDark ? "text-muted" : "text-muted"}`}>
                  {t("暂无数据", "No data")}
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>

      {/* 磁盘信息 */}
      <div className={`pt-4 ${isDark ? "border-t border-line" : "border-t border-line"}`}>
        {renderSectionHeader("disks", t("磁盘挂载", "Disk Mounts"))}
        {!isCompact || !collapsedSections.disks ? (
          <div className="space-y-2">
            {disks.map((disk) => (
              <div key={disk.mount}>
                <div className="flex justify-between items-center mb-1">
                  <span className={`text-xs ${isDark ? "text-muted" : "text-muted"}`}>
                    {disk.mount}
                  </span>
                  <span className={`text-xs font-medium ${isDark ? "text-ink-soft" : "text-ink-soft"}`}>
                    {disk.percent.toFixed(1)}% ({formatBytes(disk.used)} / {formatBytes(disk.total)})
                  </span>
                </div>
                <ProgressBar
                  percent={disk.percent}
                  isDark={isDark}
                  label={t(`磁盘 ${disk.mount} 使用率 ${disk.percent.toFixed(1)}%`, `Disk ${disk.mount} usage ${disk.percent.toFixed(1)}%`)}
                  color="cyan"
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>

    </div>
  );
}
