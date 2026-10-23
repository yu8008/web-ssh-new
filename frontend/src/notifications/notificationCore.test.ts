import { describe, expect, it } from "vitest";
import { DEFAULT_SOUND, mergeNotices, parseNotice, parsePreferences, shouldSound, soundPriority } from "./notificationCore";
import type { TerminalNotice } from "./notificationCore";

const event: TerminalNotice = { id: "one", session_id: "server-one", session_name: "Repository", app: "codex", kind: "complete", created_at: "2026-10-23T12:00:00+00:00", read_at: null };
const now = Date.parse(event.created_at) + 500;
describe("notification policy", () => {
  it("does not enable sound on first visit and recovers invalid preferences", () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_SOUND);
    expect(parsePreferences("broken")).toEqual(DEFAULT_SOUND);
    expect(parsePreferences('{"enabled":true,"volume":5,"bell":"yes"}')).toEqual({ ...DEFAULT_SOUND, enabled: true, volume: 1 });
  });
  it("validates event envelopes and bounds their text", () => {
    expect(parseNotice(event)).toEqual(event);
    for (const invalid of [null, {}, { ...event, created_at: "never" }, { ...event, kind: "run-command" }, { ...event, session_name: "x".repeat(129) }, { ...event, read_at: {} }]) expect(parseNotice(invalid)).toBeNull();
  });
  it("silences old, read, muted, future and disabled-category events", () => {
    const prefs = { ...DEFAULT_SOUND, enabled: true };
    expect(shouldSound(event, prefs, true, now)).toBe(true);
    expect(shouldSound(event, prefs, true, now + 20000)).toBe(false);
    expect(shouldSound(event, prefs, true, now - 20000)).toBe(false);
    expect(shouldSound({ ...event, read_at: event.created_at }, prefs, true, now)).toBe(false);
    expect(shouldSound(event, { ...prefs, volume: 0 }, true, now)).toBe(false);
    expect(shouldSound(event, { ...prefs, complete: false }, true, now)).toBe(false);
    expect(shouldSound({ ...event, kind: "bell" }, prefs, true, now)).toBe(false);
    for (const kind of ["question", "approval", "attention"] as const) expect(shouldSound({ ...event, kind }, prefs, true, now)).toBe(true);
  });
  it("supports foreground/background preferences and prioritizes user intervention", () => {
    const prefs = { ...DEFAULT_SOUND, enabled: true, backgroundOnly: true };
    expect(shouldSound(event, prefs, true, now)).toBe(false);
    expect(shouldSound(event, prefs, false, now)).toBe(true);
    expect(soundPriority("attention")).toBeGreaterThan(soundPriority("complete"));
    expect(soundPriority("question")).toBeGreaterThan(soundPriority("bell"));
  });
  it("merges duplicates without making read notices unread and bounds the inbox", () => {
    expect(mergeNotices([{ ...event, read_at: event.created_at }], [event])).toEqual([{ ...event, read_at: event.created_at }]);
    const items = Array.from({ length: 250 }, (_, index) => ({ ...event, id: String(index).padStart(3, "0") }));
    expect(mergeNotices([], items)).toHaveLength(200);
    expect(mergeNotices([], items)[0].id).toBe("249");
  });
});
