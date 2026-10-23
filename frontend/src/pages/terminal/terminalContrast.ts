export const LIGHT_TEXT_CONTRAST = 7;
export const LIGHT_DIM_CONTRAST = 4.5;
export const LIGHT_DIM_OPACITY = 0.8;

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

/** Opt in only for the application's white terminal theme. Other themes and
 * terminals with contrast adjustment disabled retain the upstream renderer. */
export function usesLightTextPolicy(background: number, minimumContrast: number): boolean {
  return (background >>> 0) === 0xffffffff && minimumContrast === LIGHT_TEXT_CONTRAST;
}

/** Resolve the final opaque glyph color AFTER dimming, using the actual cell
 * background (including inverse/selection). Both renderers cache this result;
 * ANSI attributes and the terminal buffer are never rewritten. */
export function readableLightForeground(background: number, foreground: number, dim: boolean, selectionBackground = background) {
  const bg = rgb(background);
  const fg = rgb(foreground);
  const source = dim ? mix(bg, fg, LIGHT_DIM_OPACITY) : fg;
  const backgroundLuminance = luminance(bg);
  const target = dim ? LIGHT_DIM_CONTRAST : LIGHT_TEXT_CONTRAST;
  // The TUI selection uses a shared darken overlay rather than xterm's
  // clear-on-input selection. Reserve enough contrast for its light backdrop
  // without scanning the buffer or repainting selected text separately.
  const selection = rgb(selectionBackground);
  const selectedBackground = luminance(bg.map((value, index) => Math.min(value, selection[index])) as RGB);
  const lightSurface = bg.every(value => value >= 224);
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
    // Find the smallest adjustment toward black/white. Keep the closest
    // achievable color on backgrounds whose maximum contrast is below target.
    for (let step = 0; step < 12; step++) {
      const amount = (low + high) / 2;
      const candidate = mix(source, endpoint, amount);
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
