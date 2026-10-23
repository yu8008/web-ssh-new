import React from "react";
import { createGatewayScene } from "./gatewayScene";

/** Event-driven spring: no idle animation loop and no React updates per frame. */
export function SignalArtwork({ className = "", interactive = false }: { className?: string; interactive?: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const element = ref.current, canvas = canvasRef.current;
    if (!element || !canvas) return;
    const scene = createGatewayScene(canvas);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, last = 0, painted = 0;
    let visible = true, alive = true, contextLost = false;
    let x = 0, y = 0, vx = 0, vy = 0, tx = 0, ty = 0;
    const light = () => document.documentElement.dataset.theme === "light";
    const render = () => {
      if (!alive || !visible || document.hidden || contextLost) return;
      if (scene?.draw(x, y, light())) element.dataset.rendered = "true";
      else delete element.dataset.rendered;
    };
    const stop = () => { cancelAnimationFrame(frame); frame = 0; last = 0; element.dataset.moving = "false"; };
    const reset = () => {
      stop(); x = y = vx = vy = tx = ty = 0;
      element.style.removeProperty("--art-x"); element.style.removeProperty("--art-y"); render();
    };
    const motionPreference = () => { if (reduced.matches) reset(); };
    const tick = (now: number) => {
      frame = 0;
      if (!alive || !visible || document.hidden || reduced.matches) { stop(); return; }
      const dt = Math.min((now - (last || now - 16)) / 1000, .032); last = now;
      vx += ((tx - x) * 95 - vx * 18) * dt; vy += ((ty - y) * 95 - vy * 18) * dt;
      x += vx * dt; y += vy * dt;
      element.style.setProperty("--art-x", `${x * 5}deg`); element.style.setProperty("--art-y", `${-y * 5}deg`);
      if (scene?.hardware && now - painted > 42) { render(); painted = now; }
      if (Math.abs(tx - x) + Math.abs(ty - y) + Math.abs(vx) + Math.abs(vy) > .002) frame = requestAnimationFrame(tick);
      else stop();
    };
    const animate = () => {
      if (!frame && visible && !document.hidden && !reduced.matches) { element.dataset.moving = "true"; frame = requestAnimationFrame(tick); }
    };
    const move = (event: PointerEvent) => {
      if (!interactive || event.pointerType !== "mouse" || reduced.matches) return;
      const bounds = element.getBoundingClientRect();
      tx = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1));
      ty = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1)); animate();
    };
    const leave = () => { tx = ty = 0; animate(); };
    const lost = (event: Event) => { event.preventDefault(); contextLost = true; stop(); delete element.dataset.rendered; };
    const visibility = () => { if (document.hidden) stop(); else render(); };
    const resize = new ResizeObserver(render), theme = new MutationObserver(render);
    const intersection = new IntersectionObserver(entries => {
      visible = entries[0]?.isIntersecting ?? false;
      if (visible) render(); else stop();
    });
    resize.observe(element); intersection.observe(element);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    element.addEventListener("pointermove", move); element.addEventListener("pointerleave", leave);
    canvas.addEventListener("webglcontextlost", lost); reduced.addEventListener("change", motionPreference);
    document.addEventListener("visibilitychange", visibility); render();
    return () => {
      alive = false; stop(); resize.disconnect(); theme.disconnect(); intersection.disconnect();
      element.removeEventListener("pointermove", move); element.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("webglcontextlost", lost); reduced.removeEventListener("change", motionPreference);
      document.removeEventListener("visibilitychange", visibility); scene?.dispose();
    };
  }, [interactive]);
  return <div ref={ref} className={`signal-art ${className}`} aria-hidden="true">
    <div className="signal-art-orbit" />
    <div className="signal-art-object">
      <img className="signal-poster signal-poster--dark" src="/art/gateway-sculpture-dark.webp" alt="" width="840" height="840" draggable={false} />
      <img className="signal-poster signal-poster--light" src="/art/gateway-sculpture-light.webp" alt="" width="840" height="840" draggable={false} />
      <canvas ref={canvasRef} width="840" height="840" />
    </div>
    <span className="signal-art-coordinate signal-art-coordinate--top">REMOTE / 01</span>
    <span className="signal-art-coordinate signal-art-coordinate--bottom">BEYOND THE WINDOW</span>
  </div>;
}
