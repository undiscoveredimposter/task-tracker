import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The desktop layout is held together by two figures — how wide the task column
 * is, and how much of the window the sidebar took — and three files have to
 * agree on them. Nothing here is checkable at 375px, where every one of these
 * resolves to "the whole screen", so it goes wrong silently on a laptop.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const css = read('./index.css');
const app = read('./App.tsx');
const ui = read('./components/ui.tsx');
const chrome = read('./components/DesktopChrome.tsx');

/** The classes on the element whose markup opens with `anchor`. */
function classesAfter(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  expect(start, `${anchor} is missing`).toBeGreaterThan(-1);
  return /className="([^"]*)"/.exec(source.slice(start))?.[1] ?? '';
}

/** The value a selector's block gives a custom property. */
function valueOf(source: string, selector: string, property: string): string | undefined {
  const start = source.indexOf(selector);
  expect(start, `${selector} is missing from index.css`).toBeGreaterThan(-1);
  const block = source.slice(start, source.indexOf('}', start));
  return new RegExp(`${property}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

const column = classesAfter(app, '<main');
// The sheet is a real <dialog> opened with showModal() since #31, so it is
// implicitly modal and carries no aria-modal to anchor on. `anim-sheet` opens
// the panel itself — the dialog around it is the full-window backdrop.
const panel = classesAfter(ui, '<div className="anim-sheet');
const sidebar = classesAfter(chrome, '<nav');

describe('the task column and the sheet that belongs to it', () => {
  it('are capped at the same width', () => {
    const capOf = (classes: string) => /(?:^|\s)(max-w-\S+)/.exec(classes)?.[1];
    expect(capOf(panel)).toBe(capOf(column));
  });

  it('are capped by a width that exists', () => {
    // A `max-w-*` naming no theme token compiles to nothing at all, and the
    // sheet goes back to spanning the window with no error anywhere.
    const cap = /(?:^|\s)max-w-(\S+)/.exec(column)?.[1];
    expect(css, `max-w-${cap} needs --container-${cap} in @theme`).toContain(
      `--container-${cap}:`,
    );
  });
});

describe('a sheet against the desktop sidebar', () => {
  const property = /w-\((--[\w-]+)\)/.exec(sidebar)?.[1];

  it('steps aside by exactly what the sidebar took', () => {
    expect(property, 'the sidebar takes its width from a custom property').toBeTruthy();
    expect(panel).toContain(`left-[var(${property},0px)]`);
  });

  it('steps aside by nothing on the screens that have no sidebar', () => {
    // Sign-in and an invite landing render sheets with no sidebar beside them,
    // so the offset has to start at zero — and be zero at 375px, always.
    expect(valueOf(css, '.has-sidebar {', String(property))).toBe('0px');
  });

  it('takes the offset up at the width the sidebar appears at', () => {
    // The two have to move together: raise the offset at a width where the
    // sidebar isn't there yet and the sheet is shoved sideways past nothing.
    expect(sidebar, 'the sidebar appears at md:').toContain('md:flex');
    const md = css.slice(css.indexOf('@media (width >= 48rem)'));
    expect(valueOf(md, '.has-sidebar {', String(property))).not.toBe('0px');
  });
});
