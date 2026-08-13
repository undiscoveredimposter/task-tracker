import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inviteStatusOf, type InviteState } from '../src/invite-policy.ts';

const now = new Date('2026-08-13T09:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
const ahead = (days: number) => new Date(now.getTime() + days * 86_400_000);

const state = (overrides: Partial<InviteState> = {}): InviteState => ({
  revokedAt: null,
  expiresAt: null,
  maxUses: null,
  useCount: 0,
  ...overrides,
});

describe('inviteStatusOf', () => {
  it('lets a fresh link through', () => {
    assert.equal(inviteStatusOf(state(), now), 'ok');
  });

  it('accepts a link that has not reached its expiry', () => {
    assert.equal(inviteStatusOf(state({ expiresAt: ahead(2) }), now), 'ok');
  });

  it('rejects one that has', () => {
    assert.equal(inviteStatusOf(state({ expiresAt: ago(1) }), now), 'expired');
  });

  it('treats the expiry instant itself as expired', () => {
    assert.equal(inviteStatusOf(state({ expiresAt: new Date(now) }), now), 'expired');
  });

  it('never expires a link with no expiry set', () => {
    assert.equal(inviteStatusOf(state({ expiresAt: null }), new Date('2099-01-01')), 'ok');
  });

  it('stops a link once its uses are spent', () => {
    assert.equal(inviteStatusOf(state({ maxUses: 1, useCount: 1 }), now), 'used_up');
    assert.equal(inviteStatusOf(state({ maxUses: 3, useCount: 4 }), now), 'used_up');
  });

  it('allows one with uses remaining', () => {
    assert.equal(inviteStatusOf(state({ maxUses: 3, useCount: 2 }), now), 'ok');
  });

  it('reports revocation ahead of expiry, because that is the more useful thing to say', () => {
    // "The owner turned this off" tells the invitee what to do next; "expired"
    // would send them back to ask for a link the owner deliberately killed.
    const both = state({ revokedAt: ago(1), expiresAt: ago(1) });
    assert.equal(inviteStatusOf(both, now), 'revoked');
  });

  it('reports revocation ahead of being used up too', () => {
    const both = state({ revokedAt: ago(1), maxUses: 1, useCount: 1 });
    assert.equal(inviteStatusOf(both, now), 'revoked');
  });
});
