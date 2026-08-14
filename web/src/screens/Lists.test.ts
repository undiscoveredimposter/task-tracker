import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

/**
 * The way into the account screen, on both layouts.
 *
 * On a phone it is the avatar in the lists-home header, which used to be
 * exactly the size of the 36px avatar inside it — the one control on the screen
 * under the brief's 44px floor, sitting in the corner where a thumb is least
 * accurate. On a desktop the lists home does not exist at all, so the same way
 * in is in the top bar and owes the same floor.
 *
 * There is no browser here, so this cannot lay the header out. What it can do
 * is refuse to take Tailwind's spacing scale on trust: the classes are read off
 * the JSX, compiled by the real compiler against the real index.css, and the
 * box resolved from the declarations that come back. Changing --spacing, or
 * dropping the class from the control, fails this with actual numbers.
 */

/** The design brief's floor for anything you can tap. */
const MIN_TAP_PX = 44;
const ROOT_FONT_PX = 16;

const require_ = createRequire(import.meta.url);
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const ENTRY = new URL('../index.css', import.meta.url);

/** The CSS Tailwind emits for these classes, tokens and all. */
async function build(classes: string[]): Promise<string> {
  const base = dirname(fileURLToPath(ENTRY));
  const compiler = await compile(readFileSync(ENTRY, 'utf8'), {
    base,
    loadStylesheet: async (id, from) => {
      // Tailwind's own entry is a package export rather than a file path.
      const path = id.startsWith('.')
        ? resolve(from, id)
        : require_.resolve(id === 'tailwindcss' ? 'tailwindcss/index.css' : id, { paths: [from] });
      return { path, base: dirname(path), content: readFileSync(path, 'utf8') };
    },
  });
  return compiler.build(classes);
}

const escapeClass = (name: string) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** One utility's declaration block, or null if it emitted nothing. */
function ruleFor(css: string, className: string): string | null {
  return new RegExp(`\\.${escapeClass(className)}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? null;
}

/**
 * A length in pixels. Tailwind writes geometry as a multiple of --spacing, so
 * the step comes out of the compiled theme rather than being assumed to be 4.
 */
function toPx(value: string, css: string): number | null {
  const step = /--spacing:\s*([\d.]+)rem\s*;/.exec(css);
  if (!step) throw new Error('--spacing is missing from the compiled theme');
  const scale = Number(step[1]) * ROOT_FONT_PX;

  const spaced = /^calc\(var\(--spacing\)\s*\*\s*(-?[\d.]+)\)$/.exec(value.trim());
  if (spaced) return Number(spaced[1]) * scale;

  const px = /^(-?[\d.]+)px$/.exec(value.trim());
  return px ? Number(px[1]) : null;
}

/**
 * The geometry these classes put on an element. Only the properties that decide
 * a hit area are resolved; `flex` and friends emit nothing measurable.
 */
async function geometry(classes: string[]): Promise<Map<string, number>> {
  const css = await build(classes);
  const found = new Map<string, number>();
  const wanted = new Set(['width', 'height', 'margin', 'margin-inline', 'margin-block']);

  for (const className of classes) {
    const rule = ruleFor(css, className);
    if (!rule) continue;
    for (const [, property, value] of rule.matchAll(/([a-z-]+):\s*([^;]+);/g)) {
      if (property === undefined || value === undefined) continue;
      if (!wanted.has(property)) continue;
      const px = toPx(value, css);
      if (px !== null) found.set(property, px);
    }
  }
  return found;
}

/** The classes written on the element carrying this aria-label. */
function classesFor(tsx: string, ariaLabel: string): string[] {
  const at = tsx.indexOf(`aria-label="${ariaLabel}"`);
  expect(at, `no element is labelled "${ariaLabel}"`).toBeGreaterThan(-1);

  const open = tsx.lastIndexOf('<', at);
  // Stop at the `>` that closes the tag, not at the one inside an `=>` arrow.
  let end = open;
  while (end < tsx.length && !(tsx[end] === '>' && tsx[end - 1] !== '=')) end += 1;

  const tag = tsx.slice(open, end);
  const written = /className="([^"]*)"/.exec(tag)?.[1];
  return written === undefined ? [] : written.trim().split(/\s+/);
}

/** The size `Avatar` draws at when nobody asks for one. */
function avatarDefaultSize(): number {
  const declared = /export function Avatar\(\{[\s\S]*?size = (\d+)/.exec(
    source('../components/ui.tsx'),
  );
  expect(declared, 'Avatar no longer declares a default size').not.toBeNull();
  return Number(declared?.[1]);
}

describe('the account link on the lists home', () => {
  const classes = classesFor(source('./Lists.tsx'), 'Your account');

  it('is at least 44px on both axes', async () => {
    const box = await geometry(classes);

    expect(box.get('width'), 'the link sets no width of its own').toBeGreaterThanOrEqual(
      MIN_TAP_PX,
    );
    expect(box.get('height'), 'the link sets no height of its own').toBeGreaterThanOrEqual(
      MIN_TAP_PX,
    );
  });

  it('grows outwards only, so the header keeps its height and the avatar its place', async () => {
    // The hit area is bled back out with a negative margin. When that bleed
    // cancels the growth exactly, the link's margin box is still the avatar's
    // old 36px box — which is what keeps the header from shifting.
    const box = await geometry(classes);
    const bleed = box.get('margin') ?? 0;

    expect(bleed).toBeLessThan(0);
    expect((box.get('width') ?? 0) + 2 * bleed).toBe(avatarDefaultSize());
    expect((box.get('height') ?? 0) + 2 * bleed).toBe(avatarDefaultSize());
  });

  it('still draws the avatar at 36, centred in the target', () => {
    // Without centring, a bigger link would move the avatar rather than just
    // grow around it, and the assertion above would be measuring the wrong box.
    expect(avatarDefaultSize()).toBe(36);
    expect(classes).toEqual(expect.arrayContaining(['flex', 'items-center', 'justify-center']));
  });
});

describe('the account link in the desktop top bar', () => {
  const classes = classesFor(source('../components/DesktopChrome.tsx'), 'Your account');

  it('is at least 44px on both axes', async () => {
    // A pointer is more accurate than a thumb, but this is the only way to the
    // account screen above `md:` and the floor is not a phone-only rule.
    const box = await geometry(classes);

    expect(box.get('width')).toBeGreaterThanOrEqual(MIN_TAP_PX);
    expect(box.get('height')).toBeGreaterThanOrEqual(MIN_TAP_PX);
  });

  it('centres whatever avatar it draws', () => {
    expect(classes).toEqual(expect.arrayContaining(['flex', 'items-center', 'justify-center']));
  });
});
