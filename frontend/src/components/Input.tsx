import React from "react";
import { cn } from "../lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type = "text", ...props },
  ref
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        "ui-input h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink",
        "placeholder:text-muted/80",
        "transition-colors duration-150",
        "hover:border-line-strong",
        "focus:border-brand/70 focus:outline-none focus:ring-2 focus:ring-brand/25",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className
      )}
      {...props}
    />
  );
});
