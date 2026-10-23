import { describe, expect, it } from "vitest";
import { readableLightForeground, readableTerminalForeground, usesLightTextPolicy, usesTerminalTextPolicy } from "./terminalContrast";

const rgba = (red: number, green: number, blue: number) => ((red << 24) | (green << 16) | (blue << 8) | 255) >>> 0;
function contrast(a: number, b: number) {
  const light = (value: number) => [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255]
    .map(channel => channel / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  return (Math.max(light(a), light(b)) + 0.05) / (Math.min(light(a), light(b)) + 0.05);
}

describe("light terminal glyph contrast", () => {
  it("preserves readable body text and gives default dim text a darker secondary color", () => {
    const body = rgba(31, 31, 31);
    expect(readableLightForeground(0xffffffff, body, false).rgba).toBe(body);
    const secondary = readableLightForeground(0xffffffff, body, true);
    expect(secondary.css).toBe("#4c4c4c");
    expect(contrast(0xffffffff, secondary.rgba)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(0xffffffff, secondary.rgba)).toBeLessThan(contrast(0xffffffff, body));
  });

  it("meets final normal/dim contrast on white and both panels for basic, indexed and RGB colors", () => {
    const foregrounds = [rgba(215, 215, 255), rgba(166, 227, 161), rgba(205, 214, 244), rgba(22, 163, 74), rgba(234, 179, 8), rgba(6, 182, 212)];
    for (const background of [0xffffffff, rgba(247, 247, 247), rgba(237, 237, 237)]) {
      for (const foreground of foregrounds) {
        for (const dim of [false, true]) {
          const result = readableLightForeground(background, foreground, dim);
          expect(contrast(background, result.rgba)).toBeGreaterThanOrEqual(dim ? 4.5 : 7);
          expect(result.rgba & 255).toBe(255);
        }
      }
    }
  });

  it("handles inverse/dark and colored backgrounds and picks the best attainable contrast", () => {
    expect(contrast(0x000000ff, readableLightForeground(0x000000ff, 0x000000ff, true).rgba)).toBeGreaterThanOrEqual(4.5);
    expect(readableLightForeground(rgba(128, 128, 128), rgba(128, 128, 128), false).css).toBe("#000000");
    expect(contrast(rgba(120, 20, 20), readableLightForeground(rgba(120, 20, 20), rgba(60, 10, 10), true).rgba)).toBeGreaterThanOrEqual(4.5);
  });

  it("reserves contrast for the independent selection overlay on light surfaces", () => {
    const selection = rgba(220, 231, 247);
    const darken = (color: number) => rgba(Math.min(color >>> 24, 220), Math.min((color >>> 16) & 255, 231), Math.min((color >>> 8) & 255, 247));
    for (const background of [0xffffffff, rgba(247, 247, 247), rgba(237, 237, 237)]) {
      for (const foreground of [rgba(205, 214, 244), rgba(215, 215, 255), rgba(166, 227, 161)]) {
        const resolved = readableLightForeground(background, foreground, true, selection);
        expect(contrast(darken(background), darken(resolved.rgba))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("opts in only for the configured light theme, including signed RGBA values", () => {
    expect(usesLightTextPolicy(0xffffffff, 7)).toBe(true);
    expect(usesLightTextPolicy(-1, 7)).toBe(true);
    expect(usesLightTextPolicy(0xffffffff, 1)).toBe(false);
    expect(usesLightTextPolicy(0xffffffff, 4.5)).toBe(false);
    expect(usesLightTextPolicy(rgba(2, 6, 23), 7)).toBe(false);
  });

  it("keeps pastel code, model and project colors vivid and readable in both themes", () => {
    const accents = [rgba(215, 215, 255), rgba(166, 227, 161), rgba(249, 190, 128), rgba(137, 220, 235)];
    for (const light of [false, true]) {
      const background = light ? 0xffffffff : 0x171717ff;
      for (const accent of accents) {
        for (const dim of [false, true]) {
          const resolved = readableTerminalForeground(background, accent, dim, background, light);
          const channels = [resolved.rgba >>> 24, (resolved.rgba >>> 16) & 255, (resolved.rgba >>> 8) & 255];
          expect(Math.max(...channels) - Math.min(...channels)).toBeGreaterThan(60);
          expect(contrast(background, resolved.rgba)).toBeGreaterThanOrEqual(light ? dim ? 4.5 : 7 : dim ? 3 : 4.5);
        }
      }
      const neutral = readableTerminalForeground(background, light ? 0x1f1f1fff : 0xecececff, false, background, light);
      expect(neutral.rgba).toBe(light ? 0x1f1f1fff : 0xecececff);
    }
    expect(usesTerminalTextPolicy(0x171717ff, 4.5)).toBe(true);
    expect(usesTerminalTextPolicy(0xffffffff, 7)).toBe(true);
    expect(usesTerminalTextPolicy(0x171717ff, 1)).toBe(false);
    expect(usesTerminalTextPolicy(0x303030ff, 4.5)).toBe(false);
  });
});
