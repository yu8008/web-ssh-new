import { describe, expect, it } from "vitest";
import { parseRuntime } from "./notificationRuntime";

describe("running CLI status", () => {
  it("does not treat saved configuration as verified live notifications", () => {
    const status = parseRuntime({ state: "attached", app: "codex", capabilities: { complete: "ready", question: "unproven", execute: "verified" }, candidates: [] });
    expect(status?.capabilities).toEqual({ complete: "ready" });
    expect(parseRuntime({ installed: true })).toBeNull();
  });
  it("bounds candidate metadata and rejects invalid identities", () => {
    const candidate = { id: "thread-one", cwd: "/project", modified_at: 100 };
    const status = parseRuntime({ state: "binding_required", candidates: [candidate, { ...candidate, id: "../other" }, { ...candidate, modified_at: NaN }] });
    expect(status?.candidates).toEqual([candidate]);
    expect(parseRuntime({ state: "binding_required", candidates: Array.from({ length: 100 }, () => candidate) })?.candidates).toHaveLength(64);
  });
});
