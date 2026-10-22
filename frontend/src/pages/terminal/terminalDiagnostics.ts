export type TerminalDiagnostics = {
  roundTripMs: number;
  gatewayQueueMs?: number;
  gatewayLagMs?: number;
  browserLagMs: number;
  outputWaitMs: number;
  outputParseMs: number;
  outputQueuedChars: number;
  renderWaitMs?: number;
  gatewayQueuedChars?: number;
  gatewayInflightChars?: number;
};

/** Timer lateness is a scheduling symptom, not a network measurement. Ignore
 * hidden tabs and the first sample after returning, which browsers throttle. */
export function createBrowserLagMonitor(view: Window) {
  let expected = view.performance.now() + 100;
  let visible = view.document.visibilityState === "visible";
  const samples: Array<{ at: number; delay: number }> = [];
  let parsedAt: number | undefined;
  let renderWaitMs: number | undefined;
  let renderedAt = -Infinity;
  const prune = () => {
    const now = view.performance.now();
    while (samples.length && samples[0].at < now - 5000) samples.shift();
  };
  const visibility = () => {
    visible = view.document.visibilityState === "visible";
    expected = view.performance.now() + 100;
    samples.length = 0;
    parsedAt = renderWaitMs = undefined;
  };
  const timer = view.setInterval(() => {
    const now = view.performance.now();
    if (visible && view.document.visibilityState === "visible") {
      samples.push({ at: now, delay: Math.max(0, now - expected) });
      prune();
    }
    expected = now + 100;
  }, 100);
  view.document.addEventListener("visibilitychange", visibility);
  return {
    maximumMs() { prune(); return Math.round(Math.max(0, ...samples.map(sample => sample.delay))); },
    parsed() { if (visible && parsedAt === undefined) parsedAt = view.performance.now(); },
    rendered() {
      if (visible && parsedAt !== undefined) {
        renderedAt = view.performance.now();
        renderWaitMs = Math.round(renderedAt - parsedAt);
        parsedAt = undefined;
      }
    },
    renderWaitMs() { return view.performance.now() - renderedAt < 5000 ? renderWaitMs : undefined; },
    dispose() { view.clearInterval(timer); view.document.removeEventListener("visibilitychange", visibility); },
  };
}
