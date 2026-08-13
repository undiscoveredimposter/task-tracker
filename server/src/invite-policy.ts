import type { InviteStatus } from '@tally/shared';

export interface InviteState {
  revokedAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
}

/**
 * Whether an invite link still works, and if not, why.
 *
 * Invite links let anyone holding them join, which is what was asked for — so
 * the guardrails are the expiry, the revoke and the optional use cap, and this
 * is the single place all three are judged.
 */
export function inviteStatusOf(invite: InviteState, now: Date = new Date()): InviteStatus {
  // Revocation is checked first deliberately. When a link is both revoked and
  // expired, "the owner turned this off" is the answer that tells the invitee
  // what to do next; "expired" would send them off to ask for a replacement the
  // owner meant to withhold.
  if (invite.revokedAt) return 'revoked';
  if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (invite.maxUses !== null && invite.useCount >= invite.maxUses) return 'used_up';
  return 'ok';
}
