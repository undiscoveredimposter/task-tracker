import { useState } from 'react';
import { applyTheme, readThemeChoice, storeThemeChoice, type ThemeChoice } from '../lib/theme';

const CHOICES: [ThemeChoice, string][] = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

/**
 * Light, dark, or whatever the phone is doing.
 *
 * The work of applying a theme happens elsewhere — the boot script in
 * index.html on launch, `watchSystemTheme` while the app is open. This only
 * records the decision, so there is no effect here to fight with either of them.
 */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readThemeChoice(window.localStorage));

  const pick = (next: ThemeChoice) => {
    storeThemeChoice(window.localStorage, next);
    applyTheme(document, next, window.matchMedia('(prefers-color-scheme: dark)').matches);
    setChoice(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <span id="appearance-label" className="text-xs font-medium text-muted">
        Appearance
      </span>
      <div role="group" aria-labelledby="appearance-label" className="flex gap-2">
        {CHOICES.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => pick(value)}
            aria-pressed={choice === value}
            className={`tap flex-1 rounded-xl text-sm ${
              choice === value
                ? 'border-[1.5px] border-accent bg-tint font-semibold text-accent-ink'
                : 'border border-control bg-surface font-medium'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
