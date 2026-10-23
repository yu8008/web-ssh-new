import React from "react";

export type CardProps = {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  titleClassName?: string;
  descClassName?: string;
};

export function Card({ title, description, children, className, titleClassName, descClassName }: CardProps) {
  return (
    <div className={`ui-card rounded-xl border border-line bg-surface p-6 ${className ?? ""}`}>
      <h2 className={`text-lg font-semibold text-ink ${titleClassName ?? ""}`}>{title}</h2>
      {description ? <p className={`mt-2 max-w-3xl text-sm text-muted ${descClassName ?? ""}`}>{description}</p> : null}
      <div className="mt-4 space-y-4">{children}</div>
    </div>
  );
}
