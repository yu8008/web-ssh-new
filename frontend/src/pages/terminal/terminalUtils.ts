import type { NetworkProfile } from "../../context/AppContextCore";

export type TargetNetworkProfile = "good" | "degraded" | "poor" | "unknown";

export type TerminalBufferLineSource = {
  readonly isWrapped: boolean;
  translateToString: (trimRight?: boolean, startColumn?: number, endColumn?: number) => string;
};

export type TerminalBufferSource = {
  readonly length: number;
  readonly baseY: number;
  readonly viewportY: number;
  getLine: (index: number) => TerminalBufferLineSource | undefined;
};

export type TerminalBufferSnapshot = {
  text: string;
  loadedLines: number;
  truncated: boolean;
  initialScrollRatio: number;
};

type TerminalBufferSnapshotLimits = {
  maxLines?: number;
  maxChars?: number;
};

export const NETWORK_PROFILE_RANK: Record<NetworkProfile, number> = {
  good: 0,
  degraded: 1,
  poor: 2,
};

export function pickWorseProfile(a: NetworkProfile, b: NetworkProfile): NetworkProfile {
  return NETWORK_PROFILE_RANK[a] >= NETWORK_PROFILE_RANK[b] ? a : b;
}

export function normalizeTargetNetworkProfile(raw: string | undefined | null): TargetNetworkProfile {
  if (raw === "good" || raw === "degraded" || raw === "poor") {
    return raw;
  }
  return "unknown";
}

const XTERM_ANSI_CUBE = [0, 95, 135, 175, 215, 255];

function toHexColor(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** 还原 xterm 默认调色板中 16~255 号索引的颜色（6x6x6 色立方 + 24 级灰阶）。 */
export function xtermPaletteColor(index: number): string {
  if (index >= 16 && index <= 231) {
    const offset = index - 16;
    return toHexColor(
      XTERM_ANSI_CUBE[Math.floor(offset / 36)],
      XTERM_ANSI_CUBE[Math.floor((offset % 36) / 6)],
      XTERM_ANSI_CUBE[offset % 6]
    );
  }
  const level = 8 + (index - 232) * 10;
  return toHexColor(level, level, level);
}

/**
 * 生成 xterm 的 extendedAnsi 调色板（对应 16~255 号索引），并按需覆盖个别索引。
 *
 * Codex 这类 TUI 在 256 色模式下会用索引色画面板底色（实测用到 235/236，
 * 默认渲染成 #262626 / #303030 的中性灰）。两种主题都映射这些面板色，
 * 已显示的单元格因此可以直接跟随主题切换。
 */
export function buildExtendedAnsiPalette(overrides: Record<number, string> = {}): string[] {
  const palette = Array.from({ length: 240 }, (_, offset) => xtermPaletteColor(offset + 16));
  for (const [rawIndex, color] of Object.entries(overrides)) {
    const index = Number(rawIndex);
    if (Number.isInteger(index) && index >= 16 && index <= 255) {
      palette[index - 16] = color;
    }
  }
  return palette;
}

export const darkTerminalTheme = {
  background: "#171717",
  foreground: "#ffffff",
  cursor: "#ffffff",
  cursorAccent: "#171717",
  selectionBackground: "#454b55",
  black: "#303030",
  red: "#ff647c",
  green: "#42df8b",
  yellow: "#ffd04a",
  blue: "#53a5ff",
  magenta: "#bf83ff",
  cyan: "#28d6ed",
  white: "#d4d4d4",
  brightBlack: "#9b9b9b",
  brightRed: "#ff7e91",
  brightGreen: "#65ef9e",
  brightYellow: "#ffde69",
  brightBlue: "#77b8ff",
  brightMagenta: "#cf9aff",
  brightCyan: "#54e5f5",
  brightWhite: "#ffffff",
  // 面板具体使用哪个色号取决于 TUI 的启动配色；保留两个表面层次。
  extendedAnsi: buildExtendedAnsiPalette({
    235: "#2a2a2a",
    236: "#303030",
  }),
};

export const lightTerminalTheme = {
  background: "#ffffff",
  foreground: "#000000",
  cursor: "#000000",
  cursorAccent: "#ffffff",
  selectionBackground: "#dce7f7",
  black: "#1f1f1f",
  red: "#c52242",
  green: "#087b3f",
  yellow: "#9a5800",
  blue: "#2459e8",
  magenta: "#8534cf",
  cyan: "#00768c",
  white: "#f4f4f4",
  brightBlack: "#666666",
  brightRed: "#d02a48",
  brightGreen: "#00864b",
  brightYellow: "#a46100",
  brightBlue: "#305ff2",
  brightMagenta: "#903ddb",
  brightCyan: "#007f98",
  brightWhite: "#ffffff",
  extendedAnsi: buildExtendedAnsiPalette({
    235: "#f7f7f7",
    236: "#ededed",
  }),
};

export const WHEEL_PIXEL_PER_LINE = 40;
export const LATENCY_HISTORY_SIZE = 30;
export const TERMINAL_COPY_MAX_LINES = 10_000;
export const TERMINAL_COPY_MAX_CHARS = 1024 * 1024;
const ALT_SCREEN_SEQUENCE = /\x1b\[\?(?:1049|1047|47)[hl]/g;
const HARD_RESET_SEQUENCE = /\x1bc/g;
const CLEAR_SCROLLBACK_SEQUENCE = /\x1b\[(?:3|2;3)J/g;
const SANITIZE_TARGET_SEQUENCES = [
  "\x1b[?1049h",
  "\x1b[?1049l",
  "\x1b[?1047h",
  "\x1b[?1047l",
  "\x1b[?47h",
  "\x1b[?47l",
  "\x1bc",
  "\x1b[3J",
  "\x1b[2;3J",
];
const SANITIZE_TARGET_MAX_LENGTH = SANITIZE_TARGET_SEQUENCES.reduce(
  (max, sequence) => Math.max(max, sequence.length),
  0
);

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function safeUtf16Suffix(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  let start = value.length - maxChars;
  const firstCodeUnit = value.charCodeAt(start);
  const previousCodeUnit = value.charCodeAt(start - 1);
  const startsWithLowSurrogate = firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff;
  const followsHighSurrogate = previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff;
  if (startsWithLowSurrogate && followsHighSurrogate) {
    start += 1;
  }
  return value.slice(start);
}

function calculateInitialScrollRatio(
  buffer: TerminalBufferSource,
  firstIncludedIndex: number,
  bufferLength: number
): number {
  if (firstIncludedIndex >= bufferLength) {
    return 0;
  }
  const rawBaseY = Number.isFinite(buffer.baseY) ? Math.floor(buffer.baseY) : 0;
  const bottomViewportY = Math.min(Math.max(rawBaseY, 0), bufferLength - 1);
  if (bottomViewportY <= firstIncludedIndex) {
    return 0;
  }
  const rawViewportY = Number.isFinite(buffer.viewportY)
    ? Math.floor(buffer.viewportY)
    : bottomViewportY;
  const viewportY = Math.min(Math.max(rawViewportY, firstIncludedIndex), bottomViewportY);
  return (viewportY - firstIncludedIndex) / (bottomViewportY - firstIncludedIndex);
}

export function createTerminalBufferSnapshot(
  buffer: TerminalBufferSource,
  limits: TerminalBufferSnapshotLimits = {}
): TerminalBufferSnapshot {
  const bufferLength = Math.max(0, Math.floor(buffer.length));
  if (bufferLength === 0) {
    return { text: "", loadedLines: 0, truncated: false, initialScrollRatio: 0 };
  }

  const maxLines = positiveInteger(limits.maxLines, TERMINAL_COPY_MAX_LINES);
  const maxChars = positiveInteger(limits.maxChars, TERMINAL_COPY_MAX_CHARS);
  let startIndex = Math.max(0, bufferLength - maxLines);
  while (startIndex > 0 && buffer.getLine(startIndex)?.isWrapped) {
    startIndex -= 1;
  }

  const reverseLines: Array<{ text: string; isWrapped: boolean; index: number }> = [];
  let usedChars = 0;
  let stoppedByCharacterLimit = false;

  for (let index = bufferLength - 1; index >= startIndex; index -= 1) {
    const line = buffer.getLine(index);
    if (!line) {
      continue;
    }
    const lineText = line.translateToString(true);
    const currentOldestLine = reverseLines[reverseLines.length - 1];
    const separatorLength = currentOldestLine && !currentOldestLine.isWrapped ? 1 : 0;
    const requiredChars = lineText.length + separatorLength;
    if (usedChars + requiredChars > maxChars) {
      stoppedByCharacterLimit = true;
      if (reverseLines.length === 0) {
        const suffix = safeUtf16Suffix(lineText, maxChars);
        reverseLines.push({ text: suffix, isWrapped: false, index });
      }
      break;
    }
    reverseLines.push({ text: lineText, isWrapped: line.isWrapped, index });
    usedChars += requiredChars;
  }

  const orderedLines = reverseLines.reverse();
  const text = orderedLines
    .map((line, index) => `${index > 0 && !line.isWrapped ? "\n" : ""}${line.text}`)
    .join("")
    .replace(/\n+$/, "");
  const firstIncludedIndex = orderedLines[0]?.index ?? bufferLength;

  return {
    text,
    loadedLines: orderedLines.length,
    truncated: stoppedByCharacterLimit || firstIncludedIndex > 0,
    initialScrollRatio: calculateInitialScrollRatio(buffer, firstIncludedIndex, bufferLength),
  };
}

/** 复制时优先取终端选区，其次取浏览器 DOM 选区。 */
export function resolveCopyText(terminalSelection: string, domSelection: string): string {
  return terminalSelection || domSelection || "";
}

export type TerminalSelectionAnchor = { x: number; y: number };

/**
 * 把“鼠标松开的位置”换算成终端容器内的气泡坐标，并夹紧到容器范围内。
 * offsetY 让气泡落在指针右下方一点，避免盖住刚选中的那行文字。
 */
export function clampSelectionAnchor(
  x: number,
  y: number,
  bounds: { width: number; height: number },
  options: { margin?: number; offsetY?: number } = {}
): TerminalSelectionAnchor {
  const margin = options.margin ?? 16;
  const offsetY = options.offsetY ?? 12;
  const maxX = Math.max(margin, bounds.width - margin);
  const maxY = Math.max(margin, bounds.height - margin);
  return {
    x: Math.min(Math.max(x, margin), maxX),
    y: Math.min(Math.max(y + offsetY, margin), maxY),
  };
}

export function normalizeWheelDeltaToLines(event: WheelEvent, terminalRows: number): number {
  let lineDelta = event.deltaY;
  if (event.deltaMode === 0) {
    lineDelta = lineDelta / WHEEL_PIXEL_PER_LINE;
  } else if (event.deltaMode === 2) {
    lineDelta = lineDelta * Math.max(terminalRows, 1);
  }
  if (!Number.isFinite(lineDelta)) {
    return 0;
  }
  return lineDelta;
}

export function normalizeWheelDeltaToPixels(event: WheelEvent, viewportHeight: number): number {
  let pixelDelta = event.deltaY;
  if (event.deltaMode === 1) {
    pixelDelta = pixelDelta * WHEEL_PIXEL_PER_LINE;
  } else if (event.deltaMode === 2) {
    pixelDelta = pixelDelta * Math.max(viewportHeight, 1);
  }
  if (!Number.isFinite(pixelDelta)) {
    return 0;
  }
  return pixelDelta;
}

function stripTerminalControlSequences(data: string): string {
  // 在增强 tmux 会话中屏蔽会重置本地滚动缓冲的控制序列，保证 xterm scrollback 可持续积累。
  return data
    .replace(ALT_SCREEN_SEQUENCE, "")
    .replace(HARD_RESET_SEQUENCE, "")
    .replace(CLEAR_SCROLLBACK_SEQUENCE, "");
}

function splitSanitizePendingSuffix(data: string): { safeOutput: string; pendingSuffix: string } {
  const maxSuffixLength = Math.min(data.length, SANITIZE_TARGET_MAX_LENGTH - 1);
  let pendingSuffix = "";
  for (let length = 1; length <= maxSuffixLength; length += 1) {
    const suffix = data.slice(-length);
    const isSequencePrefix = SANITIZE_TARGET_SEQUENCES.some(
      (sequence) => sequence.length > suffix.length && sequence.startsWith(suffix)
    );
    if (isSequencePrefix) {
      pendingSuffix = suffix;
    }
  }
  if (!pendingSuffix) {
    return { safeOutput: data, pendingSuffix: "" };
  }
  return {
    safeOutput: data.slice(0, -pendingSuffix.length),
    pendingSuffix,
  };
}

export function sanitizeTerminalOutputChunk(
  data: string,
  forceNormalBuffer: boolean,
  pendingSuffix: string
): { output: string; pendingSuffix: string } {
  if (!forceNormalBuffer || data.length === 0) {
    return { output: data, pendingSuffix: "" };
  }
  const merged = pendingSuffix + data;
  const split = splitSanitizePendingSuffix(merged);
  return {
    output: stripTerminalControlSequences(split.safeOutput),
    pendingSuffix: split.pendingSuffix,
  };
}
