import React from "react";
import { cn } from "../lib/utils";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "quiet";
  size?: "sm" | "md" | "lg" | "icon";
  loading?: boolean;
  /** @deprecated 主题已由设计令牌接管，无需手动指定 */
  lightMode?: boolean;
};

const variants: Record<string, string> = {
  primary:
    "bg-brand text-brand-ink shadow-[0_1px_0_rgb(255_255_255/0.18)_inset] hover:brightness-110 active:brightness-95 border border-transparent",
  secondary:
    "bg-surface text-ink border border-line hover:border-line-strong hover:bg-elevated active:bg-elevated",
  ghost:
    "bg-transparent text-ink-soft border border-transparent hover:bg-elevated hover:text-ink active:bg-elevated",
  quiet:
    "bg-elevated text-ink border border-transparent hover:bg-surface hover:border-line",
  danger:
    "bg-danger/12 text-danger border border-danger/30 hover:bg-danger/18 active:bg-danger/25"
};

const sizes: Record<string, string> = {
  sm: "h-8 px-2.5 text-xs gap-1.5 rounded-md",
  md: "h-9 px-3 text-sm gap-2 rounded-md",
  lg: "h-10 px-4 text-sm gap-2 rounded-md",
  icon: "h-9 w-9 p-0 rounded-md"
};

function LoadingSpinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  lightMode: _lightMode,
  className,
  disabled,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex select-none items-center justify-center whitespace-nowrap font-medium",
        "transition-[background-color,border-color,color,box-shadow,filter] duration-150 ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
        variants[variant],
        sizes[size],
        (loading || disabled) && "pointer-events-none opacity-50",
        className
      )}
      disabled={loading || disabled}
      {...props}
    >
      {loading ? <LoadingSpinner /> : null}
      {children}
    </button>
  );
}

export type ThemeAwareButtonProps = Omit<ButtonProps, "lightMode"> & {
  isDark: boolean;
};

export function ThemeAwareButton({ isDark: _isDark, ...rest }: ThemeAwareButtonProps) {
  void _isDark;
  return <Button {...rest} />;
}
