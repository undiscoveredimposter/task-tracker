/**
 * WCAG contrast, so the palette can be checked by a test rather than by eye.
 *
 * Small enough to keep rather than take a dependency on: two colour formats and
 * one ratio, and it only ever runs against the tokens in index.css.
 */

/** Channels 0–255, alpha 0–1. */
type Rgba = [r: number, g: number, b: number, a: number];

const HEX = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i;

/** `#abc`, `#aabbcc`, `rgb(…)` or `rgba(…)` — the only forms the tokens use. */
export function parseColor(value: string): Rgba {
  const input = value.trim();

  if (HEX.test(input)) {
    const digits = input.slice(1);
    const pairs =
      digits.length === 3 ? [...digits].map((digit) => digit + digit) : [0, 2, 4].map((at) => digits.slice(at, at + 2));
    const [r, g, b] = pairs.map((pair) => parseInt(pair!, 16));
    return [r!, g!, b!, 1];
  }

  const parts = RGB.exec(input);
  if (parts) {
    return [Number(parts[1]), Number(parts[2]), Number(parts[3]), parts[4] === undefined ? 1 : Number(parts[4])];
  }

  // Named colours and colour spaces we don't use: better to stop than to score
  // a pair the test author thought it was checking.
  throw new Error(`Cannot read the colour "${value}"`);
}

/** Lays a possibly-translucent colour over an opaque one. */
function flatten(fg: Rgba, bg: Rgba): Rgba {
  return [
    fg[0] * fg[3] + bg[0] * (1 - fg[3]),
    fg[1] * fg[3] + bg[1] * (1 - fg[3]),
    fg[2] * fg[3] + bg[2] * (1 - fg[3]),
    1,
  ];
}

/** WCAG 2.x relative luminance. */
function luminance([r, g, b]: Rgba): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * The ratio between two colours, 1:1 to 21:1.
 *
 * The background is taken as opaque — it is a token like `--t-surface`, painted
 * over the page — and a translucent foreground is flattened onto it first,
 * which is how `--t-muted` is defined and how the browser renders it.
 */
export function contrastRatio(foreground: string, background: string): number {
  const bg = parseColor(background);
  const light = luminance(flatten(parseColor(foreground), bg));
  const dark = luminance(bg);
  const [high, low] = light > dark ? [light, dark] : [dark, light];
  return (high + 0.05) / (low + 0.05);
}
