import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { LIST_EMOJI } from '@tally/shared';
import { api } from '../lib/api';
import { useData } from '../lib/store';
import { Sheet } from './ui';

/**
 * Making a space — a second household, a holiday flat, somewhere to keep the
 * things one particular person should see.
 *
 * It lands on the space's own screen rather than back on the home, because an
 * empty space is only worth making if the next thing you do is share it or put
 * a list in it, and both start there.
 */
export function NewSpaceSheet({ onClose }: { onClose: () => void }) {
  const { refreshLists } = useData();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string>(LIST_EMOJI[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const space = await api.createSpace({ name, emoji });
      await refreshLists();
      onClose();
      setName('');
      navigate(`/s/${space.id}`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="New space" onClose={onClose}>
      <form onSubmit={create} className="flex flex-col gap-3">
        <label className="text-xs font-medium text-muted" htmlFor="space-name">
          Name
        </label>
        <input
          id="space-name"
          autoFocus
          required
          maxLength={80}
          placeholder="The flat"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="field"
        />
        <span className="text-xs font-medium text-muted">Emoji</span>
        <div className="flex flex-wrap gap-2">
          {LIST_EMOJI.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setEmoji(option)}
              aria-pressed={emoji === option}
              className={`size-12 rounded-2xl text-[22px] ${
                emoji === option ? 'border-[1.5px] border-accent bg-tint' : 'border border-control bg-surface'
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        <p className="text-xs leading-snug text-muted">
          Everyone you share a space with sees every list in it — including lists you add later.
        </p>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary mt-1">
          {busy ? 'Creating…' : 'Create space'}
        </button>
      </form>
    </Sheet>
  );
}
