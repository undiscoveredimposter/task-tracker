import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_COLOR,
  applyTheme,
  readThemeChoice,
  resolveTheme,
  storeThemeChoice,
  watchSystemTheme,
  type ThemeChoice,
} from './theme';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  poison(key: string, value: string): void {
    this.data.set(key, value);
  }
}

/** Just enough of the document for the theme to write to, with no DOM present. */
class FakeDocument {
  attributes = new Map<string, string>();
  meta: { content: string } | null = { content: '' };

  documentElement = {
    setAttribute: (name: string, value: string) => void this.attributes.set(name, value),
    removeAttribute: (name: string) => void this.attributes.delete(name),
  };

  querySelector(selectors: string) {
    if (selectors !== 'meta[name="theme-color"]' || !this.meta) return null;
    const meta = this.meta;
    return { setAttribute: (_name: string, value: string) => void (meta.content = value) };
  }
}

class FakeMedia {
  private listeners = new Set<() => void>();
  constructor(public matches: boolean) {}
  addEventListener(_type: 'change', listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'change', listener: () => void): void {
    this.listeners.delete(listener);
  }
  /** The operating system flipping between light and dark. */
  flip(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) listener();
  }
  get count(): number {
    return this.listeners.size;
  }
}

let storage: MemoryStorage;
let doc: FakeDocument;

beforeEach(() => {
  storage = new MemoryStorage();
  doc = new FakeDocument();
});

describe('readThemeChoice', () => {
  it('follows the operating system until someone says otherwise', () => {
    expect(readThemeChoice(storage)).toBe('system');
  });

  it('reads back what was stored', () => {
    storeThemeChoice(storage, 'dark');
    expect(readThemeChoice(storage)).toBe('dark');
  });

  it('falls back to system for a value it does not recognise', () => {
    storage.poison('tally.theme', 'sepia');
    expect(readThemeChoice(storage)).toBe('system');
  });

  it('shrugs off storage that throws instead of failing to start', () => {
    // Safari in private browsing, or a full quota.
    const hostile = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(readThemeChoice(hostile)).toBe('system');
    expect(() => storeThemeChoice(hostile, 'light')).not.toThrow();
  });
});

describe('resolveTheme', () => {
  it.each([
    ['system', true, 'dark'],
    ['system', false, 'light'],
    ['light', true, 'light'],
    ['light', false, 'light'],
    ['dark', true, 'dark'],
    ['dark', false, 'dark'],
  ] as [ThemeChoice, boolean, string][])(
    '%s with system dark=%s renders %s',
    (choice, systemPrefersDark, expected) => {
      expect(resolveTheme(choice, systemPrefersDark)).toBe(expected);
    },
  );
});

describe('applyTheme', () => {
  it('marks the root for an explicit dark choice', () => {
    applyTheme(doc, 'dark', false);
    expect(doc.attributes.get('data-theme')).toBe('dark');
    expect(doc.meta?.content).toBe(THEME_COLOR.dark);
  });

  it('marks the root for an explicit light choice, even at night', () => {
    applyTheme(doc, 'light', true);
    expect(doc.attributes.get('data-theme')).toBe('light');
    expect(doc.meta?.content).toBe(THEME_COLOR.light);
  });

  it('clears the marker for system, so the media query decides', () => {
    applyTheme(doc, 'dark', false);
    applyTheme(doc, 'system', true);
    expect(doc.attributes.has('data-theme')).toBe(false);
    expect(doc.meta?.content).toBe(THEME_COLOR.dark);
  });

  it('tracks the operating system while on system', () => {
    applyTheme(doc, 'system', false);
    expect(doc.meta?.content).toBe(THEME_COLOR.light);
  });

  it('carries on when there is no theme-color meta to update', () => {
    doc.meta = null;
    expect(() => applyTheme(doc, 'dark', false)).not.toThrow();
    expect(doc.attributes.get('data-theme')).toBe('dark');
  });

  it('reports the theme it settled on', () => {
    expect(applyTheme(doc, 'system', true)).toBe('dark');
  });
});

describe('watchSystemTheme', () => {
  it('follows the operating system live while the choice is system', () => {
    const media = new FakeMedia(false);
    watchSystemTheme(doc, storage, media);

    media.flip(true);

    expect(doc.attributes.has('data-theme')).toBe(false);
    expect(doc.meta?.content).toBe(THEME_COLOR.dark);
  });

  it('leaves an explicit choice alone when the operating system flips', () => {
    storeThemeChoice(storage, 'light');
    const media = new FakeMedia(false);
    watchSystemTheme(doc, storage, media);

    media.flip(true);

    expect(doc.attributes.get('data-theme')).toBe('light');
    expect(doc.meta?.content).toBe(THEME_COLOR.light);
  });

  it('re-reads the stored choice rather than the one it started with', () => {
    // The toggle writes to storage; this listener must not hold a stale copy.
    const media = new FakeMedia(false);
    watchSystemTheme(doc, storage, media);
    storeThemeChoice(storage, 'dark');

    media.flip(false);

    expect(doc.meta?.content).toBe(THEME_COLOR.dark);
  });

  it('stops listening once released', () => {
    const media = new FakeMedia(false);
    const stop = watchSystemTheme(doc, storage, media);
    expect(media.count).toBe(1);
    stop();
    expect(media.count).toBe(0);
  });

  it('does not touch the document until something changes', () => {
    // The boot script has already painted the right palette; re-applying here
    // would only risk disagreeing with it.
    const media = new FakeMedia(true);
    const spy = vi.spyOn(doc.documentElement, 'removeAttribute');
    watchSystemTheme(doc, storage, media);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the three copies of the palette', () => {
  // THEME_COLOR, the tokens in index.css and the boot script in index.html all
  // carry the same two colours, because each runs at a point where it cannot
  // reach the others. Drift between them shows up as a status bar that is the
  // wrong shade of nearly-right, which nobody would ever spot by eye.
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const css = read('../index.css');
  const html = read('../../index.html');

  /** The value of --t-ground in the block a selector opens. */
  const groundOf = (selector: string) => {
    const start = css.indexOf(selector);
    expect(start, `${selector} is missing from index.css`).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('}', start));
    return /--t-ground:\s*([^;]+);/.exec(block)?.[1]?.trim();
  };

  it('agrees with the light tokens', () => {
    expect(groundOf(':root {')).toBe(THEME_COLOR.light);
  });

  it('agrees with the dark tokens, both ways of reaching them', () => {
    expect(groundOf(":root:not([data-theme='light']) {")).toBe(THEME_COLOR.dark);
    expect(groundOf(":root[data-theme='dark'] {")).toBe(THEME_COLOR.dark);
  });

  it('lets an explicit light choice beat a dark operating system', () => {
    // Without the :not(), picking Light at 11pm would do nothing at all.
    expect(css).toContain(":root:not([data-theme='light'])");
  });

  it('agrees with the boot script that paints before this module exists', () => {
    expect(html).toContain("localStorage.getItem('tally.theme')");
    expect(html).toContain(THEME_COLOR.light);
    expect(html).toContain(THEME_COLOR.dark);
  });
});
