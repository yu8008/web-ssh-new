import { describe, expect, it } from "vitest";
import { isPathWithinDirectory, normalizeDirectoryPath } from "./filePaths";

describe("project file navigation", () => {
  it("resolves dot segments and repeated separators without stripping filename spaces", () => {
    expect(normalizeDirectoryPath("/workspace//app/./src/../folder / ")).toBe("/workspace/app/folder / ");
    expect(normalizeDirectoryPath("/../../etc/")).toBe("/etc");
  });
  it("allows the project and its children, excluding siblings and parent escapes", () => {
    expect(isPathWithinDirectory("/workspace/app", "/workspace/app/")).toBe(true);
    expect(isPathWithinDirectory("/workspace/app/src/main.ts", "/workspace/app")).toBe(true);
    for (const path of ["/", "/workspace", "/workspace/application", "/workspace/app/../other", "/workspace/app/src/../../other"]) {
      expect(isPathWithinDirectory(path, "/workspace/app")).toBe(false);
    }
    expect(isPathWithinDirectory("/etc", "/")).toBe(true);
  });
});
