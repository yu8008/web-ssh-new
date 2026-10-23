export type CliRuntime = {
  state: string; app?: "codex" | "claude"; pid?: number; binding?: string; cwd?: string;
  capabilities: Record<string, string>;
  candidates: Array<{ id: string; cwd: string; modified_at: number; title?: string }>;
};

export function parseRuntime(value: unknown): CliRuntime | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.state !== "string" || item.state.length > 40) return null;
  const capabilities: Record<string, string> = {};
  if (item.capabilities && typeof item.capabilities === "object") {
    for (const [key, status] of Object.entries(item.capabilities)) {
      if (["complete", "question", "approval", "attention"].includes(key) && ["ready", "verified"].includes(String(status))) capabilities[key] = String(status);
    }
  }
  const candidates = Array.isArray(item.candidates) ? item.candidates.slice(0, 64).flatMap(raw => {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(raw.id) || typeof raw.cwd !== "string" || typeof raw.modified_at !== "number" || !Number.isFinite(raw.modified_at)) return [];
    return [{ id: raw.id, cwd: raw.cwd.slice(0, 512), modified_at: raw.modified_at, ...(typeof raw.title === "string" ? { title: raw.title.slice(0, 200) } : {}) }];
  }) : [];
  return { state: item.state, capabilities, candidates,
    app: item.app === "codex" || item.app === "claude" ? item.app : undefined,
    binding: typeof item.binding === "string" ? item.binding.slice(0, 80) : undefined,
    cwd: typeof item.cwd === "string" ? item.cwd.slice(0, 512) : undefined };
}
