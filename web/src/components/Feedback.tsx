import { useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { FEEDBACK_MESSAGE_MAX, type FeedbackKind } from '@tally/shared';
import { api } from '../lib/api';
import { FeedbackIcon, Sheet } from './ui';

/**
 * The feedback icon at the top of the app, and the sheet it opens.
 *
 * What is sent becomes an issue on the project's public GitHub repository,
 * where it is triaged. The sheet says so in plain words before anything is
 * written, because "public" is the one thing about it nobody would guess.
 */

const KINDS: { id: FeedbackKind; label: string; prompt: string; placeholder: string }[] = [
  {
    id: 'idea',
    label: 'Idea',
    prompt: 'What would make Tally better?',
    placeholder: 'It would help if…',
  },
  {
    id: 'bug',
    label: 'Bug',
    prompt: 'What went wrong?',
    placeholder: 'What you did, what you expected, and what happened instead',
  },
  { id: 'other', label: 'Other', prompt: "What's on your mind?", placeholder: '' },
];

export function FeedbackButton({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Send feedback"
        title="Send feedback"
        className={`flex size-11 items-center justify-center text-muted hover:text-ink ${className}`}
      >
        <FeedbackIcon />
      </button>
      {open && <FeedbackSheet onClose={() => setOpen(false)} />}
    </>
  );
}

export function FeedbackSheet({ onClose }: { onClose: () => void }) {
  const { pathname } = useLocation();
  const [kind, setKind] = useState<FeedbackKind>('idea');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const current = KINDS.find((option) => option.id === kind)!;

  const send = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.sendFeedback({ kind, message, screen: pathname });
      setSent(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <Sheet title="Thanks" onClose={onClose}>
        <div className="flex flex-col gap-4">
          <p role="status" className="text-[15px] leading-relaxed text-pretty">
            Got it. Every message is read and weighed up — small things that make Tally better
            tend to arrive in an update soon after.
          </p>
          <button type="button" autoFocus onClick={onClose} className="btn btn-primary">
            Done
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="Send feedback" onClose={onClose}>
      <form onSubmit={send} className="flex flex-col gap-3">
        <span className="text-xs font-medium text-muted" id="feedback-kind">
          What kind?
        </span>
        <div role="group" aria-labelledby="feedback-kind" className="flex gap-2">
          {KINDS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setKind(option.id)}
              aria-pressed={kind === option.id}
              className={`tap flex-1 rounded-2xl text-[15px] ${
                kind === option.id
                  ? 'border-[1.5px] border-accent bg-tint font-semibold'
                  : 'border border-control bg-surface font-medium'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="text-xs font-medium text-muted" htmlFor="feedback-message">
          {current.prompt}
        </label>
        <textarea
          id="feedback-message"
          autoFocus
          required
          maxLength={FEEDBACK_MESSAGE_MAX}
          placeholder={current.placeholder}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          className="field min-h-[132px] resize-none py-3"
        />

        <p className="text-xs leading-snug text-muted text-pretty">
          This is posted publicly on GitHub so it can be worked on. Your name and email aren't
          included — leave anything private out of the message too.
        </p>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy || !message.trim()} className="btn btn-primary mt-1">
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>
    </Sheet>
  );
}
