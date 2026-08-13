import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { UserRef } from '@tally/shared';
import { initialOf } from '../lib/format';

/* ── Icons ───────────────────────────────────────────────────────────────── */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const CheckIcon = ({ size = 16, className = '' }: { size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={3} className={className}>
    <path d="M5 12.5l4.5 4.5 9-10" />
  </svg>
);

export const BackIcon = () => (
  <svg width={22} height={22} viewBox="0 0 24 24" {...stroke} strokeWidth={2.2}>
    <path d="M14.5 5l-7 7 7 7" />
  </svg>
);

export const PlusIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={2.4}>
    <path d="M12 4v16M4 12h16" />
  </svg>
);

export const CloseIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={2.2}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const OfflineIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={2}>
    <path d="M3 3l18 18" />
    <path d="M5 10a12 12 0 0 1 5.4-3M12.5 6.6A12 12 0 0 1 21 10" opacity={0.7} />
    <path d="M8 13.5a7 7 0 0 1 2.5-1.5M13.7 12.3a7 7 0 0 1 2.8 1.7" opacity={0.7} />
    <circle cx="12" cy="17.5" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

export const LinkIcon = () => (
  <svg width={18} height={18} viewBox="0 0 24 24" {...stroke} strokeWidth={1.8} className="shrink-0">
    <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5" />
    <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5" />
  </svg>
);

export const TrashIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" {...stroke} strokeWidth={2}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0l-.8 12a2 2 0 0 1-2 1.9H8.8a2 2 0 0 1-2-1.9L6 7" />
  </svg>
);

export const ChevronIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={2.2}>
    <path d="M6 9.5l6 6 6-6" />
  </svg>
);

export const TallyMark = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={2.2} className="text-accent">
    <path d="M4.5 12.5l5 5 10-11" />
  </svg>
);

export const GoogleIcon = () => (
  <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z" />
    <path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1 .7-2.4 1.2-4 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
    <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z" />
    <path fill="#EA4335" d="M12 4.7c1.7 0 3.3.6 4.5 1.8L20 3A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-5 6.7-5z" />
  </svg>
);

/* ── Building blocks ─────────────────────────────────────────────────────── */

const TINTS = ['bg-tint', 'bg-tint2', 'bg-tint3'];

export function Avatar({
  user,
  index = 0,
  size = 36,
  ring = false,
}: {
  user: Pick<UserRef, 'displayName' | 'photoUrl'>;
  index?: number;
  size?: number;
  ring?: boolean;
}) {
  const tint = TINTS[index % TINTS.length];
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-accent-ink ${tint} ${
        ring ? 'border-2 border-surface' : ''
      }`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      title={user.displayName}
    >
      {initialOf(user.displayName)}
    </span>
  );
}

export function AvatarStack({ users, size = 28 }: { users: UserRef[]; size?: number }) {
  return (
    <div className="flex">
      {users.slice(0, 4).map((user, index) => (
        <span key={user.id} className={index > 0 ? '-ml-2' : ''}>
          <Avatar user={user} index={index} size={size} ring />
        </span>
      ))}
      {users.length > 4 && (
        <span className="-ml-2 inline-flex items-center justify-center rounded-full border-2 border-surface bg-track text-[11px] font-semibold" style={{ width: size, height: size }}>
          +{users.length - 4}
        </span>
      )}
    </div>
  );
}

export function ProgressBar({ done, total }: { done: number; total: number }) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div
      className="h-1.5 flex-1 overflow-hidden rounded-full bg-track"
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={`${done} of ${total} done`}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-300"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

export function ScreenHeader({
  title,
  back,
  right,
}: {
  title: ReactNode;
  back?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 py-1">
      {back && (
        <Link
          to={back}
          aria-label="Back"
          className="-ml-3 flex size-11 items-center justify-center text-accent-ink"
        >
          <BackIcon />
        </Link>
      )}
      <span className="truncate text-[22px] font-semibold tracking-tight">{title}</span>
      {right && <div className="ml-auto flex items-center gap-1">{right}</div>}
    </div>
  );
}

export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-30">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="anim-fadein absolute inset-0 bg-black/55"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="anim-sheet absolute inset-x-0 bottom-0 rounded-t-3xl bg-surface px-5 pt-2 pb-[calc(env(safe-area-inset-bottom)+24px)] shadow-[0_-12px_40px_rgba(0,0,0,.4)]"
      >
        <div className="flex justify-center pt-1 pb-3">
          <span className="h-1.5 w-10 rounded-full bg-outline" />
        </div>
        <div className="mb-4 flex items-center gap-3">
          <span className="text-lg font-semibold">{title}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto flex size-11 items-center justify-center text-muted"
          >
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-10 text-center">
      {icon}
      <div className="mt-2 text-lg font-semibold">{title}</div>
      {children && <p className="text-sm leading-relaxed text-muted text-pretty">{children}</p>}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`anim-shimmer rounded-2xl bg-track ${className}`} />;
}

export function ListSkeleton() {
  return (
    <div className="px-4 pt-2" aria-busy="true" aria-label="Loading">
      <Skeleton className="mt-2 mb-3.5 h-7 w-36 rounded-lg" />
      <Skeleton className="mb-4 h-1.5 w-full rounded-full" />
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-16" />
        ))}
      </div>
    </div>
  );
}

/** Fixed bar at the bottom of a screen, clear of the home indicator. */
export function BottomBar({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`safe-bottom pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-ground from-55% to-transparent px-4 pt-3 ${className}`}
    >
      <div className="pointer-events-auto">{children}</div>
    </div>
  );
}
