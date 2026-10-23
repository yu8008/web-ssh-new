import type { Terminal } from "@xterm/xterm";
import { darkTerminalTheme, lightTerminalTheme, xtermPaletteColor } from "./terminalUtils";

export const TERMINAL_MINIMUM_CONTRAST = 4.5;

/** Keep near-black/near-white neutral panel backgrounds themeable. Foreground
 * colors, saturated backgrounds and middle grays retain their ANSI meaning. */
function panelIndex(red: number, green: number, blue: number): number | undefined {
  const low = Math.min(red, green, blue);
  const high = Math.max(red, green, blue);
  if (low < 0 || high > 255 || high - low > 24) return;
  const lightness = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  if (high <= 72) return lightness < 42 ? 235 : 236;
  if (low >= 224) return lightness >= 247 ? 235 : 236;
}

function indexedPanel(index: number): number | undefined {
  // The first 16 slots are theme-defined. Only the conventional black/white
  // backgrounds are surfaces; do not reclassify arbitrary basic colors.
  if (index === 0) return 235;
  if (index === 7) return 236;
  if (index === 15) return 235;
  if (!Number.isInteger(index) || index < 16 || index > 255) return;
  const color = xtermPaletteColor(index);
  return panelIndex(...[1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16)) as [number, number, number]);
}

function mapSgr(sequence: string): string {
  const introducer = sequence.startsWith("\x1b") ? "\x1b[" : "\x9b";
  const body = sequence.slice(introducer.length, -1);
  if (!/(?:^|;)(?:48(?:[;:]|$)|(?:40|47|107)(?:;|$))/.test(body)) return sequence;
  if (!/^[\d;:]*$/.test(body)) return sequence;
  const params = body.split(";");
  const mapped: string[] = [];
  for (let i = 0; i < params.length;) {
    const value = Number(params[i]);
    let count = 1;
    let panel: number | undefined;
    if (params[i].includes(":")) {
      const sub = params[i].split(":");
      if (sub[0] === "48") {
        if (sub[1] === "5" && sub.length === 3) panel = indexedPanel(Number(sub[2]));
        if (sub[1] === "2" && (sub.length === 5 || (sub.length === 6 && (!sub[2] || sub[2] === "0")))) {
          panel = panelIndex(...sub.slice(-3).map(Number) as [number, number, number]);
        }
      }
    } else if (value === 38 || value === 48 || value === 58) {
      // Skip entire color operands, including foreground/underline colors, so
      // an RGB channel such as 40 or 48 cannot be mistaken for a background.
      const mode = Number(params[i + 1]);
      count = mode === 2 ? 5 : mode === 5 ? 3 : 1;
      if (i + count > params.length) return sequence;
      if (value === 48 && mode === 2) panel = panelIndex(...params.slice(i + 2, i + 5).map(Number) as [number, number, number]);
      if (value === 48 && mode === 5) panel = indexedPanel(Number(params[i + 2]));
    } else if (value === 40 || value === 47 || value === 107) {
      panel = indexedPanel(value === 40 ? 0 : value === 47 ? 7 : 15);
    }
    mapped.push(panel === undefined ? params.slice(i, i + count).join(";") : `48;5;${panel}`);
    i += count;
  }
  return introducer + mapped.join(";") + "m";
}

/** A bounded streaming ANSI adapter. It only normalizes SGR backgrounds before
 * xterm parses them, so both history and future output use the same palette.
 * OSC/DCS/APC payloads pass through verbatim; server history/ACKs stay raw. */
export function createTerminalColorMapper() {
  let state: "text" | "escape" | "csi" | "csi-pass" | "string" | "string-escape" = "text";
  let pending = "";
  let osc = false;
  return {
    reset() { state = "text"; pending = ""; osc = false; },
    transform(data: string): string {
      const output: string[] = [];
      for (let i = 0; i < data.length;) {
        if (state === "text") {
          const next = /[\x1b\x90\x98\x9b\x9d\x9e\x9f]/g;
          next.lastIndex = i;
          const match = next.exec(data);
          if (!match) { output.push(data.slice(i)); break; }
          output.push(data.slice(i, match.index));
          const char = match[0];
          i = match.index + 1;
          if (char === "\x1b") { state = "escape"; pending = char; }
          else if (char === "\x9b") { state = "csi"; pending = char; }
          else { output.push(char); state = "string"; osc = char === "\x9d"; }
        } else if (state === "escape") {
          const char = data[i++];
          if (char === "[") { pending += char; state = "csi"; }
          else if (char === "\x1b") { output.push(pending); pending = char; }
          else {
            output.push(pending + char);
            pending = "";
            state = /[\]PX^_]/.test(char) ? "string" : "text";
            osc = char === "]";
          }
        } else if (state === "csi") {
          const char = data[i++];
          if (char === "\x1b") { output.push(pending); pending = char; state = "escape"; continue; }
          pending += char;
          if (char >= "@" && char <= "~") {
            output.push(char === "m" ? mapSgr(pending) : pending);
            pending = "";
            state = "text";
          } else if (pending.length >= 512 || char === "\x18" || char === "\x1a") {
            output.push(pending);
            pending = "";
            state = char === "\x18" || char === "\x1a" ? "text" : "csi-pass";
          }
        } else if (state === "csi-pass") {
          const char = data[i++];
          output.push(char);
          if (char === "\x1b") { output.pop(); pending = char; state = "escape"; }
          else if ((char >= "@" && char <= "~") || char === "\x18" || char === "\x1a") state = "text";
        } else if (state === "string-escape") {
          const char = data[i++];
          output.push(char);
          if (char === "\\" || char === "\x9c" || char === "\x18" || char === "\x1a" || (osc && char === "\x07")) state = "text";
          else if (char !== "\x1b") state = "string";
        } else {
          const end = /[\x1b\x9c\x18\x1a\x07]/g;
          end.lastIndex = i;
          let match: RegExpExecArray | null;
          do { match = end.exec(data); } while (match?.[0] === "\x07" && !osc);
          if (!match) { output.push(data.slice(i)); break; }
          output.push(data.slice(i, match.index + 1));
          i = match.index + 1;
          state = match[0] === "\x1b" ? "string-escape" : "text";
        }
      }
      return output.join("");
    },
  };
}

export function createTerminalColors(term: Terminal) {
  const mapper = createTerminalColorMapper();
  let pendingTheme: boolean | undefined;
  const apply = () => {
    if (pendingTheme === undefined || term.modes.synchronizedOutputMode) return;
    const theme = pendingTheme ? darkTerminalTheme : lightTerminalTheme;
    pendingTheme = undefined;
    if (term.options.theme === theme && term.options.minimumContrastRatio === TERMINAL_MINIMUM_CONTRAST) return;
    term.options.minimumContrastRatio = TERMINAL_MINIMUM_CONTRAST;
    term.options.theme = theme;
    term.refresh(0, term.rows - 1);
  };
  // Do not expose parsed half-frames when a theme changes during DEC 2026.
  // onRender also covers the core's missing-sync-end timeout recovery.
  const parsed = term.onWriteParsed(apply);
  const rendered = term.onRender(apply);
  return {
    write(data: string, done: () => void) { term.write(mapper.transform(data), done); },
    reset: mapper.reset,
    setTheme(isDark: boolean) { pendingTheme = isDark; apply(); },
    dispose() { pendingTheme = undefined; parsed.dispose(); rendered.dispose(); mapper.reset(); },
  };
}
