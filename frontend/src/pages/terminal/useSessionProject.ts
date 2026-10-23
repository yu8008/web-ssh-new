import React from "react";
import { getSessionProject, type SessionProject } from "../../lib/api";

/** Inspect only while a project panel is visible, never in the terminal stream. */
export function useSessionProject(sessionId: string | undefined, connected: boolean, enabled: boolean, includeGit: boolean) {
  const [data, setData] = React.useState<SessionProject | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(false);
  const refreshRef = React.useRef(() => {});
  React.useEffect(() => {
    setData(null); setError(false); setLoading(false);
    if (!sessionId || !connected || !enabled) return;
    let disposed = false, timer: number | undefined, request: AbortController | undefined;
    const stop = () => { window.clearTimeout(timer); request?.abort(); request = undefined; };
    const poll = async () => {
      stop();
      if (disposed || document.hidden) return;
      const controller = new AbortController(); request = controller;
      setLoading(true);
      try {
        const result = await getSessionProject(sessionId, includeGit, controller.signal);
        if (!disposed && request === controller) { setData(result); setError(false); }
      } catch {
        if (!disposed && request === controller && !controller.signal.aborted) { setData(null); setError(true); }
      } finally {
        if (!disposed && request === controller) {
          request = undefined; setLoading(false);
          timer = window.setTimeout(() => void poll(), includeGit ? 4000 : 2500);
        }
      }
    };
    const visibility = () => { if (document.hidden) { stop(); setLoading(false); } else void poll(); };
    refreshRef.current = () => { void poll(); };
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => { disposed = true; stop(); refreshRef.current = () => {}; document.removeEventListener("visibilitychange", visibility); };
  }, [sessionId, connected, enabled, includeGit]);
  return { data, loading, error, connected, refresh: React.useCallback(() => refreshRef.current(), []) };
}

export type SessionProjectState = ReturnType<typeof useSessionProject>;
