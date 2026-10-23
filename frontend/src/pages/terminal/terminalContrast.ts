export const LIGHT_TEXT_CONTRAST = 7;
export const LIGHT_DIM_CONTRAST = 4.5;
export const LIGHT_DIM_OPACITY = 0.8;
export const DARK_TEXT_CONTRAST = 4.5;
export const DARK_DIM_CONTRAST = 3;

type RGB = [number, number, number];

function rgb(rgba: number): RGB {
  return [rgba >>> 24, (rgba >>> 16) & 255, (rgba >>> 8) & 255];
}

function luminance(color: RGB): number {
  return color.reduce((sum, channel, index) => {
    const value = channel / 255;
    return sum + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function mix(from: RGB, to: RGB, amount: number): RGB {
  return from.map((value, index) => Math.round(value + (to[index] - value) * amount)) as RGB;
}

function hsl(color: RGB): [number, number, number] {
  const [r, g, b] = color.map(value => value / 255);
  const high = Math.max(r, g, b), low = Math.min(r, g, b), delta = high - low;
  const lightness = (high + low) / 2;
  if (!delta) return [0, 0, lightness];
  const hue = high === r ? ((g - b) / delta + 6) % 6 : high === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [hue / 6, delta / (1 - Math.abs(2 * lightness - 1)), lightness];
}

function fromHsl(hue: number, saturation: number, lightness: number): RGB {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue * 6) % 2 - 1));
  const channels = hue < 1 / 6 ? [chroma, x, 0] : hue < 2 / 6 ? [x, chroma, 0]
    : hue < 3 / 6 ? [0, chroma, x] : hue < 4 / 6 ? [0, x, chroma]
    : hue < 5 / 6 ? [x, 0, chroma] : [chroma, 0, x];
  return channels.map(value => Math.round((value + lightness - chroma / 2) * 255)) as RGB;
}

/** Restore color in pastel ANSI/RGB glyphs without tinting neutral body text.
 * Color families retain their hue; dark-theme accents no longer wash to white. */
function vividForeground(color: RGB, light: boolean): RGB {
  if (Math.max(...color) - Math.min(...color) < 16) return color;
  const [hue, saturation, lightness] = hsl(color);
  return fromHsl(hue, Math.max(saturation, light ? 0.8 : 0.76), light ? lightness : Math.min(lightness, 0.72));
}

/** Opt in only for the application's white terminal theme. Other themes and
 * terminals with contrast adjustment disabled retain the upstream renderer. */
export function usesLightTextPolicy(background: number, minimumContrast: number): boolean {
  return (background >>> 0) === 0xffffffff && minimumContrast === LIGHT_TEXT_CONTRAST;
}

export function usesTerminalTextPolicy(background: number, minimumContrast: number): boolean {
  return usesLightTextPolicy(background, minimumContrast)
    || ((background >>> 0) === 0x171717ff && minimumContrast === DARK_TEXT_CONTRAST);
}

/** Resolve the final opaque glyph color AFTER dimming, using the actual cell
 * background (including inverse/selection). Both renderers cache this result;
 * ANSI attributes and the terminal buffer are never rewritten. */
export function readableLightForeground(background: number, foreground: number, dim: boolean, selectionBackground = background) {
  return readableTerminalForeground(background, foreground, dim, selectionBackground, true);
}

export function readableTerminalForeground(background: number, foreground: number, dim: boolean, selectionBackground: number, light: boolean) {
  const bg = rgb(background);
  const fg = vividForeground(rgb(foreground), light);
  const source = dim ? mix(bg, fg, light ? LIGHT_DIM_OPACITY : 0.72) : fg;
  const backgroundLuminance = luminance(bg);
  const target = light ? dim ? LIGHT_DIM_CONTRAST : LIGHT_TEXT_CONTRAST : dim ? DARK_DIM_CONTRAST : DARK_TEXT_CONTRAST;
  // The TUI selection uses a shared darken overlay rather than xterm's
  // clear-on-input selection. Reserve enough contrast for its light backdrop
  // without scanning the buffer or repainting selected text separately.
  const selection = rgb(selectionBackground);
  const selectedBackground = luminance(bg.map((value, index) => Math.min(value, selection[index])) as RGB);
  const lightSurface = light && bg.every(value => value >= 224);
  const readable = (candidate: RGB) => contrast(backgroundLuminance, luminance(candidate)) >= target
    && (!lightSurface || contrast(selectedBackground,
      luminance(candidate.map((value, index) => Math.min(value, selection[index])) as RGB)) >= LIGHT_DIM_CONTRAST);
  let result = source;
  if (!readable(source)) {
    const black: RGB = [0, 0, 0];
    const white: RGB = [255, 255, 255];
    const endpoint = contrast(backgroundLuminance, 0) >= contrast(backgroundLuminance, 1) ? black : white;
    let low = 0;
    let high = 1;
    result = endpoint;
    const [hue, saturation, lightness] = hsl(source);
    const endLightness = endpoint === black ? 0 : 1;
    // Change lightness at a fixed hue/saturation instead of mixing pastel
    // colors with gray. Keep the best attainable contrast on mid-tone panels.
    for (let step = 0; step < 12; step++) {
      const amount = (low + high) / 2;
      const candidate = fromHsl(hue, saturation, lightness + (endLightness - lightness) * amount);
      if (readable(candidate)) {
        high = amount;
        result = candidate;
      } else {
        low = amount;
      }
    }
  }
  const [red, green, blue] = result;
  return {
    css: `#${result.map(value => value.toString(16).padStart(2, "0")).join("")}`,
    rgba: ((red << 24) | (green << 16) | (blue << 8) | 255) >>> 0,
  };
}
