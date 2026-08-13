import { useEffect, useState } from 'react';
import { Sheet, TallyMark } from './ui';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'tally.installDismissed';

const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as { standalone?: boolean }).standalone === true;

/**
 * Offers to install the app.
 *
 * Chrome and friends fire `beforeinstallprompt`, which gives a real button.
 * Safari fires nothing and shows no install affordance at all, so iOS gets the
 * three-tap explanation instead — otherwise the feature simply doesn't exist
 * for the half of a household on iPhones.
 */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);

  useEffect(() => {
    if (isStandalone() || window.localStorage.getItem(DISMISSED_KEY)) return;

    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);

    // Give iOS users the hint only after they've stuck around a little — an
    // instruction sheet on first paint is just an obstacle.
    const timer = isIos() ? setTimeout(() => setShowIosHint(true), 20_000) : undefined;

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      clearTimeout(timer);
    };
  }, []);

  const dismiss = () => {
    window.localStorage.setItem(DISMISSED_KEY, '1');
    setDeferred(null);
    setShowIosHint(false);
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    dismiss();
  };

  if (deferred) {
    return (
      <Sheet title="Put Tally on your home screen" onClose={dismiss}>
        <div className="mb-3.5 flex items-center gap-3.5">
          <span className="flex size-13 shrink-0 items-center justify-center rounded-2xl border-[1.5px] border-accent">
            <TallyMark size={26} />
          </span>
          <p className="text-[13px] text-muted">
            Opens full-screen, works offline, one tap from the fridge.
          </p>
        </div>
        <button type="button" onClick={() => void install()} className="btn btn-primary w-full">
          Install
        </button>
        <button type="button" onClick={dismiss} className="tap w-full text-sm text-muted">
          Maybe later
        </button>
      </Sheet>
    );
  }

  if (showIosHint) {
    return (
      <Sheet title="Add Tally to your home screen" onClose={dismiss}>
        <ol className="flex flex-col gap-3">
          {[
            'Tap the Share button in Safari’s toolbar',
            'Scroll down and choose Add to Home Screen',
            'Tap Add — that’s it',
          ].map((step, index) => (
            <li key={step} className="flex items-center gap-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-tint text-[13px] font-semibold text-accent-ink">
                {index + 1}
              </span>
              <span className="text-sm leading-snug">{step}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3.5 text-xs leading-relaxed text-muted text-pretty">
          Safari doesn&apos;t show an install button, so it&apos;s these three taps instead.
        </p>
        <button type="button" onClick={dismiss} className="btn btn-plain mt-3 w-full">
          Got it
        </button>
      </Sheet>
    );
  }

  return null;
}
