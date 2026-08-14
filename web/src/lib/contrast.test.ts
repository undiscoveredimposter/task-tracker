import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio, over } from './contrast';

describe('contrastRatio', () => {
  it('is 21 between black and white, the widest there is', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('is 1 for a colour against itself', () => {
    expect(contrastRatio('#5d5294', '#5d5294')).toBeCloseTo(1, 5);
  });

  it('reads the same either way round', () => {
    expect(contrastRatio('#ffffff', '#767676')).toBeCloseTo(contrastRatio('#767676', '#ffffff'), 5);
  });

  it('agrees with the WCAG worked example', () => {
    // #767676 on white is the canonical "just passes AA" grey, at 4.54:1.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('accepts three-digit hex', () => {
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5);
  });

  it('flattens a translucent foreground onto its background first', () => {
    // Half-strength black over white is mid-grey, not black.
    expect(contrastRatio('rgba(0, 0, 0, 0.5)', '#ffffff')).toBeCloseTo(
      contrastRatio('#808080', '#ffffff'),
      1,
    );
  });

  it('treats a fully transparent foreground as invisible', () => {
    expect(contrastRatio('rgba(0, 0, 0, 0)', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('refuses a colour it cannot read rather than scoring it', () => {
    expect(() => contrastRatio('rebeccapurple', '#ffffff')).toThrow(/rebeccapurple/);
  });
});

describe('over', () => {
  it('gives back the colour that actually lands on the screen', () => {
    expect(over('rgba(0, 0, 0, 0.5)', '#ffffff')).toBe('rgb(128, 128, 128)');
  });

  it('leaves an opaque colour where it is', () => {
    expect(over('#5d5294', '#ffffff')).toBe('rgb(93, 82, 148)');
  });

  it('returns something contrastRatio can read straight back', () => {
    expect(contrastRatio(over('rgba(0, 0, 0, 0.5)', '#ffffff'), '#ffffff')).toBeCloseTo(
      contrastRatio('#808080', '#ffffff'),
      5,
    );
  });

  it('composites twice differently from compositing once', () => {
    // The point of the function: a border over a card is not the same colour as
    // the same border over the page, even though the token is identical.
    expect(over('rgba(41, 43, 49, 0.54)', '#fdfdff')).not.toBe(
      over('rgba(41, 43, 49, 0.54)', '#f3f5fe'),
    );
  });
});

/* ── The palettes, as shipped ────────────────────────────────────────────── */

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

/** Every `--t-*` declaration in the block a selector opens. */
function palette(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  expect(start, `${selector} is missing from index.css`).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...block.matchAll(/--t-([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]),
  );
}

const AA_TEXT = 4.5; // WCAG 1.4.3, and every piece of text in Tally is small text
const AA_NON_TEXT = 3; // WCAG 1.4.11, for a control's own shape and state

/**
 * Every foreground/background pair the app actually puts on screen.
 *
 * Contrast is the one part of the design that cannot be checked by looking —
 * the light `muted` sat at 3.9:1 for four milestones and read perfectly well to
 * anyone whose eyes it happened to suit. Each row names where it appears so a
 * failure points at a screen rather than at a token.
 */
const PAIRS: [fg: string, bg: string, min: number, where: string][] = [
  ['ink', 'surface', AA_TEXT, 'task titles on a card'],
  ['ink', 'ground', AA_TEXT, 'screen headings'],
  ['muted', 'surface', AA_TEXT, 'notes under a task, hints on a card'],
  ['muted', 'ground', AA_TEXT, 'the reset countdown in a list header, sign-in small print'],
  ['muted', 'tint', AA_TEXT, 'the open list in the desktop sidebar — the tightest muted pairing'],
  ['muted', 'tint-2', AA_TEXT, 'the cadence explainer in list settings'],
  ['accent-ink', 'surface', AA_TEXT, 'the "Sam · 7:42am" line on a done row'],
  ['accent-ink', 'ground', AA_TEXT, 'the Stats / Share / Settings links'],
  ['accent-ink', 'tint', AA_TEXT, 'the offline banner, the 7/30-day toggle'],
  ['accent-ink', 'tint-2', AA_TEXT, 'avatar initials'],
  ['accent-ink', 'tint-3', AA_TEXT, 'avatar initials'],
  ['danger', 'surface', AA_TEXT, 'Delete and Revoke'],
  ['danger', 'ground', AA_TEXT, 'the danger zone in list settings'],
  ['toast-ink', 'toast-bg', AA_TEXT, 'the undo toast'],
  ['toast-ink', 'toast-btn', AA_TEXT, 'the Undo button inside it'],
  ['check-ink', 'accent', AA_TEXT, 'the tick inside a completed checkbox'],
  ['outline', 'surface', AA_NON_TEXT, 'the ring on an unticked task — the whole point of the row'],
  ['control', 'surface', AA_NON_TEXT, 'the edge of a text field, a plain button, an unselected chip'],
  ['accent', 'surface', AA_NON_TEXT, 'the focus ring, and the primary button border'],
  ['accent', 'ground', AA_NON_TEXT, 'the focus ring, and the primary button border'],
  ['accent', 'track', AA_NON_TEXT, 'the progress bar against its groove'],
];

// `divider` still has no row, and that is now a decision rather than an
// omission. It draws hairlines between regions — the rule under the top bar,
// the sidebar edge, the "or with email" line, the one above the danger zone —
// and none of them carries meaning, so 1.4.11 does not reach them and taking
// them to 3:1 would only make the app heavier. Everything that is genuinely a
// control's boundary moved to `control`, which is scored above.

describe.each([
  ['light', ':root {'],
  ['dark, from the operating system', ":root:not([data-theme='light']) {"],
  ['dark, chosen explicitly', ":root[data-theme='dark'] {"],
])('the %s palette', (_name, selector) => {
  const tokens = palette(selector);

  it.each(PAIRS)('%s on %s clears %s:1 — %s', (fg, bg, min, _where) => {
    const foreground = tokens[fg];
    const background = tokens[bg];
    expect(foreground, `--t-${fg} is missing`).toBeDefined();
    expect(background, `--t-${bg} is missing`).toBeDefined();
    expect(contrastRatio(foreground!, background!)).toBeGreaterThanOrEqual(min);
  });
});

/**
 * A control has two edges and the pairs above only score one of them.
 *
 * `background-clip` is `border-box`, so `control` paints over the control's own
 * `surface` fill rather than over the page — which makes the outer edge a
 * different sum from the inner one, and the weaker of the two in light. Scoring
 * the raw token against `ground` reads 3.26:1 where the screen shows 3.09:1,
 * which is exactly the kind of gap between source and pixels that lets a
 * failure ship.
 */
describe.each([
  ['light', ':root {'],
  ['dark, from the operating system', ":root:not([data-theme='light']) {"],
  ['dark, chosen explicitly', ":root[data-theme='dark'] {"],
])('a filled control in the %s palette', (_name, selector) => {
  const tokens = palette(selector);

  it('has an outer edge that clears 3:1 against the page behind it', () => {
    const edge = over(tokens.control!, tokens.surface!);
    expect(contrastRatio(edge, tokens.ground!)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

describe('the two ways of reaching dark', () => {
  it('define the same palette, so a chosen dark matches an inherited one', () => {
    expect(palette(":root[data-theme='dark'] {")).toEqual(
      palette(":root:not([data-theme='light']) {"),
    );
  });
});

describe('the component rules that draw a control', () => {
  /** The declarations in the block a component selector opens. */
  function rule(selector: string): string {
    const start = css.indexOf(`${selector} {`);
    expect(start, `${selector} is missing from index.css`).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf('}', start));
  }

  // The pairings above only prove the token is strong enough. This is the half
  // that keeps regressing: a field's edge is a component boundary, and reaching
  // for the hairline because it is the quieter of the two is how it got to
  // 1.3:1 in the first place.
  it.each(['.field', '.btn-plain'])('%s takes its border from --t-control', (selector) => {
    expect(rule(selector)).toMatch(/border:[^;]*var\(--t-control\)/);
  });
});
