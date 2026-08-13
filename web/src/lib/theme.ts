/**
 * The light/dark choice.
 *
 * The palettes themselves live in index.css: `:root` is light, and dark comes
 * from either `prefers-color-scheme` or `[data-theme="dark"]`. All this does is
 * decide whether to override the operating system, and keep the browser's own
 * chrome — the status bar in a standalone window — the same colour as the app.
 */

/** What someone picked. */
export type ThemeChoice = 'system' | 'light' | 'dark';

/** What they end up looking at. */
export type Theme = 'light' | 'dark';

/**
 * The ground colour of each palette, for the `theme-color` meta.
 *
 * These are `--t-ground` from index.css. The boot script in index.html carries
 * the same two values so it can paint before this module is parsed; change one
 * and change all three.
 */
export const THEME_COLOR: Record<Theme, string> = {
  light: '#f3f5fe',
  dark: '#161826',
};

const STORAGE_KEY = 'tally.theme';

const CHOICES: ThemeChoice[] = ['system', 'light', 'dark'];

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The slice of the document a theme touches, so this is testable without a DOM. */
export interface ThemeDocument {
  documentElement: {
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  };
  querySelector(selectors: string): { setAttribute(name: string, value: string): void } | null;
}

/** The slice of `MediaQueryList` used to follow the operating system. */
export interface ThemeMedia {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export function readThemeChoice(storage: ThemeStorage): ThemeChoice {
  try {
    const stored = storage.getItem(STORAGE_KEY);
    // An unknown value means an older build or a hand-edited key; following the
    // operating system is the safe reading of "we don't know".
    return CHOICES.find((choice) => choice === stored) ?? 'system';
  } catch {
    return 'system';
  }
}

export function storeThemeChoice(storage: ThemeStorage, choice: ThemeChoice): void {
  try {
    storage.setItem(STORAGE_KEY, choice);
  } catch {
    // Private browsing, or storage full. The choice still applies for this
    // session; only remembering it is lost.
  }
}

export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): Theme {
  if (choice !== 'system') return choice;
  return systemPrefersDark ? 'dark' : 'light';
}

/**
 * Puts the choice on the root element and in the `theme-color` meta.
 *
 * System deliberately *removes* the attribute rather than setting a value of
 * its own, so the palette keeps tracking `prefers-color-scheme` in CSS with no
 * JavaScript in the loop.
 */
export function applyTheme(
  doc: ThemeDocument,
  choice: ThemeChoice,
  systemPrefersDark: boolean,
): Theme {
  const theme = resolveTheme(choice, systemPrefersDark);

  if (choice === 'system') doc.documentElement.removeAttribute('data-theme');
  else doc.documentElement.setAttribute('data-theme', choice);

  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);

  return theme;
}

/**
 * Keeps the `theme-color` meta in step when the operating system flips between
 * light and dark under a choice of System. CSS handles the palette itself; the
 * meta is the one part of the theme no stylesheet can reach.
 *
 * Reads the stored choice on each change rather than closing over it, so this
 * can be started once for the life of the app and never go stale.
 */
export function watchSystemTheme(
  doc: ThemeDocument,
  storage: ThemeStorage,
  media: ThemeMedia,
): () => void {
  const apply = () => void applyTheme(doc, readThemeChoice(storage), media.matches);
  media.addEventListener('change', apply);
  return () => media.removeEventListener('change', apply);
}
