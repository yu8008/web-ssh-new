import React from "react";

/** Pointer-driven presentation artwork. No animation loop or terminal work. */
export function SignalArtwork({ className = "", interactive = false }: { className?: string; interactive?: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const frame = React.useRef(0);
  React.useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive || event.pointerType !== "mouse" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width - .5) * 14;
    const y = ((event.clientY - box.top) / box.height - .5) * 14;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      ref.current?.style.setProperty("--art-x", `${x}deg`);
      ref.current?.style.setProperty("--art-y", `${-y}deg`);
    });
  };
  return <div ref={ref} className={`signal-art ${className}`} aria-hidden="true" onPointerMove={move} onPointerLeave={() => {
    cancelAnimationFrame(frame.current);
    ref.current?.style.setProperty("--art-x", "0deg"); ref.current?.style.setProperty("--art-y", "0deg");
  }}><img src="/art/signal-orbit.svg" alt="" width="800" height="760" draggable={false} /></div>;
}
