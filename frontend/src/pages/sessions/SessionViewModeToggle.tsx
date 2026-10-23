import React from "react";
import { List, PanelsTopLeft } from "lucide-react";
import { cn } from "../../lib/utils";
import type { SessionViewMode } from "./sessionsUtils";

type SessionViewModeToggleProps = {
  value: SessionViewMode;
  onChange: (value: SessionViewMode) => void;
  isDark: boolean;
  t: (zh: string, en: string) => string;
  className?: string;
  fullWidth?: boolean;
};

export function SessionViewModeToggle({ value, onChange, isDark, t, className, fullWidth = false }: SessionViewModeToggleProps) {
  const options: Array<{ value: SessionViewMode; label: string; icon: React.ElementType }> = [
    { value: "list", label: t("列表", "List"), icon: List },
    { value: "grouped", label: t("分组", "Grouped"), icon: PanelsTopLeft },
  ];

  return (
    <div
      className={cn(
        "inline-flex rounded-md border p-1",
        fullWidth ? "w-full" : "",
        isDark ? "border-line bg-surface/70" : "border-line bg-surface shadow-sm",
        className
      )}
      role="group"
      aria-label={t("会话显示模式", "Session view mode")}
    >
      {options.map((item) => {
        const Icon = item.icon;
        const selected = value === item.value;
        return (
          <button
            key={item.value}
            type="button"
            className={cn(
              "inline-flex min-h-11 items-center justify-center gap-2 rounded px-3 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand",
              fullWidth ? "flex-1" : "",
              selected
                ? "bg-brand text-white shadow-sm"
                : isDark
                  ? "text-ink-soft hover:bg-elevated hover:text-ink"
                  : "text-ink-soft hover:bg-elevated hover:text-ink"
            )}
            aria-pressed={selected}
            onClick={() => onChange(item.value)}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
