import { SquareTerminal } from "lucide-react";

export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className={`brand-lockup ${compact ? "brand-lockup--compact" : ""}`}>
    <span className="brand-symbol"><SquareTerminal size={20} strokeWidth={1.7} aria-hidden="true" /></span>
    <span className="brand-type">WebSSH<span className="brand-edition">GATEWAY</span></span>
  </span>;
}
