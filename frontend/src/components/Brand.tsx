export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className={`brand-lockup ${compact ? "brand-lockup--compact" : ""}`}>
    <span className="brand-symbol" aria-hidden="true" />
    <span className="brand-type">WebSSH<span className="brand-edition">GATEWAY</span></span>
  </span>;
}
