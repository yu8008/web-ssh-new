/** Probe the existing terminal connection, excluding HTTP connection setup.
 * This includes gateway/browser scheduling, but not SSH or terminal painting. */
export function createTerminalLatencyProbe(
  view: Window,
  send: (pingId: number) => void,
  onSample: (milliseconds: number | null) => void,
) {
  let nextId = 0;
  let pending: { id: number; started: number } | undefined;
  let disposed = false;
  const probe = () => {
    if (disposed) return;
    if (view.document.visibilityState === "hidden") {
      pending = undefined;
      onSample(null);
      return;
    }
    const now = view.performance.now();
    if (pending && now - pending.started < 15000) return;
    if (pending) onSample(null);
    pending = { id: ++nextId, started: now };
    send(pending.id);
  };
  const timer = view.setInterval(probe, 5000);
  probe();
  return {
    pong(pingId: number) {
      if (disposed || pending?.id !== pingId) return null;
      const milliseconds = Math.round(view.performance.now() - pending.started);
      pending = undefined;
      onSample(view.document.visibilityState === "hidden" ? null : milliseconds);
      return view.document.visibilityState === "hidden" ? null : milliseconds;
    },
    dispose() {
      disposed = true;
      pending = undefined;
      view.clearInterval(timer);
    },
  };
}
