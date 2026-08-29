import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { LIST_EMOJI } from '@tally/shared';
import { api } from '../lib/api';
import { useData } from '../lib/store';
import { ChevronIcon, Sheet } from './ui';

/**
 * Creating a list, reachable from the lists home on a phone and from the
 * sidebar on a desktop. One implementation so the two can't drift apart.
 */
export function NewListSheet({ onClose }: { onClose: () => void }) {
  const { spaces, setList, refreshLists } = useData();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string>(LIST_EMOJI[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  // Somewhere you are allowed to add a list. With none, the server makes you a
  // space of your own on the way past, so there is nothing to ask about.
  const destinations = spaces.filter((space) => space.role !== 'viewer');
  const [spaceId, setSpaceId] = useState<string>(destinations[0]?.id ?? '');
  const chosen = destinations.find((space) => space.id === spaceId);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const detail = await api.createList({
        name,
        emoji,
        ...(spaceId ? { spaceId } : {}),
        // The device's own zone is very nearly always the right guess, and it's
        // one fewer decision on the way to a working list.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setList(detail);
      // The home screen groups by space, and this one may have just brought a
      // space into existence.
      void refreshLists();
      onClose();
      setName('');
      navigate(`/l/${detail.id}`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="New list" onClose={onClose}>
      <form onSubmit={create} className="flex flex-col gap-3">
        <label className="text-xs font-medium text-muted" htmlFor="list-name">
          Name
        </label>
        <input
          id="list-name"
          autoFocus
          required
          maxLength={80}
          placeholder="Home"
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
        {destinations.length > 1 && (
          <>
            <label className="text-xs font-medium text-muted" htmlFor="list-space">
              Space
            </label>
            <div className="relative">
              <select
                id="list-space"
                value={spaceId}
                onChange={(event) => setSpaceId(event.target.value)}
                className="field appearance-none pr-10"
              >
                {destinations.map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.emoji} {space.name}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-muted">
                <ChevronIcon />
              </span>
            </div>
            {chosen && chosen.members.length > 1 && (
              <p className="text-xs leading-snug text-muted">
                Everyone in {chosen.name} will see this list — {chosen.members.length} people.
              </p>
            )}
          </>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary mt-1">
          {busy ? 'Creating…' : 'Create list'}
        </button>
        <p className="text-xs leading-relaxed text-muted">
          It starts as a daily list resetting at 4am. You can change that in settings.
        </p>
      </form>
    </Sheet>
  );
}
