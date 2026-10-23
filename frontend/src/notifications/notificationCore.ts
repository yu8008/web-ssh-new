export type NoticeKind = "complete" | "question" | "approval" | "attention" | "bell";
export type TerminalNotice = {
  id: string; session_id: string; session_name: string; kind: NoticeKind;
  app: "codex" | "claude" | "terminal"; created_at: string; read_at: string | null;
};
export type SoundPreferences = {
  enabled: boolean; complete: boolean; attention: boolean; bell: boolean;
  volume: number; backgroundOnly: boolean;
};
export const SOUND_KEY = "webssh-notification-sound-v1";
export const DEFAULT_SOUND: SoundPreferences = {
  enabled: false, complete: true, attention: true, bell: false, volume: 0.35, backgroundOnly: false,
};
export function parsePreferences(value: string | null): SoundPreferences {
  try {
    const item = JSON.parse(value ?? "null");
    const result = { ...DEFAULT_SOUND };
    if (!item || typeof item !== "object") return result;
    for (const key of ["enabled", "complete", "attention", "bell", "backgroundOnly"] as const) {
      if (typeof item[key] === "boolean") result[key] = item[key];
    }
    if (typeof item.volume === "number" && Number.isFinite(item.volume)) result.volume = Math.max(0, Math.min(1, item.volume));
    return result;
  } catch { return { ...DEFAULT_SOUND }; }
}
export function parseNotice(value: unknown): TerminalNotice | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (!["complete", "question", "approval", "attention", "bell"].includes(String(item.kind)) || !["codex", "claude", "terminal"].includes(String(item.app))) return null;
  for (const [key, limit] of [["id", 64], ["session_id", 64], ["session_name", 128], ["created_at", 40]] as const) {
    if (typeof item[key] !== "string" || item[key].length > limit || !item[key]) return null;
  }
  if (!Number.isFinite(Date.parse(item.created_at as string)) || (item.read_at !== null && typeof item.read_at !== "string")) return null;
  return item as TerminalNotice;
}
export function mergeNotices(current: TerminalNotice[], incoming: TerminalNotice[]): TerminalNotice[] {
  const items = new Map(current.map(item => [item.id, item]));
  incoming.forEach(item => {
    const previous = items.get(item.id);
    items.set(item.id, previous?.read_at && !item.read_at ? { ...item, read_at: previous.read_at } : item);
  });
  return [...items.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).slice(0, 200);
}
export function shouldSound(event: TerminalNotice, preferences: SoundPreferences, foreground: boolean, now = Date.now()): boolean {
  const age = now - Date.parse(event.created_at);
  if (!preferences.enabled || preferences.volume <= 0 || event.read_at || age < -5000 || age > 10000 || (preferences.backgroundOnly && foreground)) return false;
  return event.kind === "complete" ? preferences.complete : event.kind === "bell" ? preferences.bell : preferences.attention;
}
export const soundPriority = (kind: NoticeKind) => kind === "question" || kind === "approval" || kind === "attention" ? 2 : kind === "complete" ? 1 : 0;
