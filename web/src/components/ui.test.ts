import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BottomBar, OfflineBanner } from './ui';

/**
 * `OfflineBanner` holds the only live region on the lists home, and the wording
 * it announces has to be the wording it shows. Both are easy to break and
 * neither is visible when you break it — a live region that has moved inside a
 * conditional still looks right, and a second wording still reads right.
 *
 * Static markup is enough to hold that down: the component is pure, so no DOM
 * and no effects are involved. Anything needing a real DOM is #25's job.
 */

const NOW = Date.now();
const THREE_HOURS_AGO = NOW - 3 * 3_600_000;

const render = (props: { online: boolean; pending: number; savedAt: number | null }) =>
  renderToStaticMarkup(createElement(OfflineBanner, props));

/** The text of the `role="status"` region, which is what actually gets spoken. */
const announced = (markup: string) =>
  /<p role="status" class="sr-only">(.*?)<\/p>/s.exec(markup)?.[1] ?? null;

describe('OfflineBanner', () => {
  it('keeps the live region in the page when there is nothing to say', () => {
    // A region that arrives at the same moment as its text is a region nothing
    // was watching, and it may never be announced at all.
    expect(announced(render({ online: true, pending: 0, savedAt: THREE_HOURS_AGO }))).toBe('');
  });

  it('shows no banner in that case, so an empty box never appears', () => {
    expect(render({ online: true, pending: 0, savedAt: THREE_HOURS_AGO })).not.toContain('bg-tint');
  });

  it('says the copy is remembered rather than claiming it is current', () => {
    // The regression this guards: a second wording that reassured a reader the
    // list was fine while the screen said it was three hours old.
    expect(announced(render({ online: false, pending: 0, savedAt: THREE_HOURS_AGO }))).toBe(
      'Offline — showing what was here 3 hours ago',
    );
  });

  it('announces exactly what it shows, in every state', () => {
    const states = [
      { online: true, pending: 2, savedAt: THREE_HOURS_AGO },
      { online: false, pending: 0, savedAt: THREE_HOURS_AGO },
      { online: false, pending: 2, savedAt: THREE_HOURS_AGO },
      { online: false, pending: 0, savedAt: null },
    ];

    for (const state of states) {
      const markup = render(state);
      const spoken = announced(markup);
      expect(spoken).toBeTruthy();
      // The visible half repeats the sentence, so it must appear twice over.
      expect(markup.split(spoken as string)).toHaveLength(3);
    }
  });

  it('hides the visible half from the accessible tree so it is not read twice', () => {
    expect(render({ online: false, pending: 0, savedAt: null })).toContain('aria-hidden="true"');
  });

  it('drops the no-signal icon once the queue is only draining', () => {
    // "Syncing 2 ticks…" beside a crossed-out signal says the opposite of itself.
    expect(render({ online: true, pending: 2, savedAt: null })).not.toContain('<svg');
    expect(render({ online: false, pending: 2, savedAt: null })).toContain('<svg');
  });
});

/**
 * The bar and the rule that hides it live in different files and neither is any
 * use without the other. Drop the class and the bar comes back as a ghost of the
 * sheet sliding up over it; drop the rule and nothing on screen says so either.
 */
describe('BottomBar while a sheet is open', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

  it('carries the class the rule is written against', () => {
    expect(renderToStaticMarkup(createElement(BottomBar, { children: null }))).toContain(
      'bottom-bar',
    );
  });

  it('is taken off screen for as long as any sheet is open', () => {
    expect(css).toMatch(/body:has\(dialog\[open\]\)\s+\.bottom-bar\s*\{[^}]*opacity:\s*0/);
  });
});
