-- Sharing moves up a level: from a list to the space that holds it.
--
-- Until now a person was invited to one list at a time, and `list_members` was
-- both the membership and the permission. That makes "share this with my
-- household" a chore that has to be repeated for every list, and again for
-- every list made afterwards. A space is the answer: you are a member of a
-- space, at one role, and that role is your role on every list inside it. Share
-- the space once and everything in it follows — including lists that don't
-- exist yet.
--
-- Two consequences this migration has to carry:
--
--   * Roles have to merge. Someone who was an editor on one of your lists and a
--     viewer on another can only hold one role in the space they both land in.
--     The strongest wins, so nobody loses a capability they were using — but it
--     does mean a viewer can come out of this able to edit. `list_members` is
--     kept (renamed) at the bottom of this file so that judgement stays
--     reversible by hand.
--   * Outstanding invite links have to be revoked. A link created against one
--     list would otherwise start granting its whole space, which is strictly
--     more than the person who sent it agreed to. Links are cheap to recreate;
--     silently widening one is not.

CREATE TABLE spaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  emoji      text NOT NULL DEFAULT '🏠',
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX spaces_owner_idx ON spaces (owner_id);

CREATE TABLE space_members (
  space_id  uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, user_id)
);

-- Every list-scoped read now resolves the caller through this, so it is on the
-- hot path in a way list_members_user_idx never was.
CREATE INDEX space_members_user_idx ON space_members (user_id);

-- One space per person who has anything to put in it. Someone with no lists of
-- their own gets none here: they can join somebody else's, and their own is
-- created the first time they make a list.
INSERT INTO spaces (name, emoji, owner_id, created_at)
SELECT CASE WHEN u.display_name <> '' THEN u.display_name || '’s home' ELSE 'Home' END,
       '🏠',
       u.id,
       u.created_at
  FROM users u
 WHERE EXISTS (SELECT 1 FROM lists l WHERE l.owner_id = u.id);

/* ── Lists belong to a space ─────────────────────────────────────────────── */

ALTER TABLE lists ADD COLUMN space_id uuid REFERENCES spaces(id) ON DELETE CASCADE;

-- Unambiguous: exactly one space exists per owner at this point in the file.
UPDATE lists l SET space_id = s.id FROM spaces s WHERE s.owner_id = l.owner_id;

ALTER TABLE lists ALTER COLUMN space_id SET NOT NULL;

-- A list kept out of its space: visible to its owner alone, however the space
-- is shared. Without it, the only way to have something private is a space of
-- its own, and "share everything here" stops being a safe thing to agree to.
ALTER TABLE lists ADD COLUMN private boolean NOT NULL DEFAULT false;

CREATE INDEX lists_space_idx ON lists (space_id) WHERE archived_at IS NULL;

/* ── Membership rolls up ─────────────────────────────────────────────────── */

-- Strongest role wins, per the note at the top. joined_at keeps the earliest of
-- the rows being merged, so "member since" stays true rather than resetting to
-- the deploy.
INSERT INTO space_members (space_id, user_id, role, joined_at)
SELECT l.space_id,
       m.user_id,
       (ARRAY['viewer', 'editor', 'owner'])[
         MAX(CASE m.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END)
       ],
       MIN(m.joined_at)
  FROM list_members m
  JOIN lists l ON l.id = m.list_id
 GROUP BY l.space_id, m.user_id;

-- A space's owner is a member of it, whatever the rolled-up rows said. Belt and
-- braces: every owner already has an 'owner' row on their own lists, so this
-- should be a no-op — but a space whose owner cannot reach it is unrecoverable
-- through the API, and that is not a risk worth carrying to save two lines.
INSERT INTO space_members (space_id, user_id, role)
SELECT s.id, s.owner_id, 'owner' FROM spaces s
    ON CONFLICT (space_id, user_id) DO UPDATE SET role = 'owner';

/* ── Invites are space-scoped ────────────────────────────────────────────── */

ALTER TABLE invites ADD COLUMN space_id uuid REFERENCES spaces(id) ON DELETE CASCADE;

UPDATE invites i SET space_id = l.space_id FROM lists l WHERE l.id = i.list_id;

-- Revoked, not deleted: an owner opening the share screen should find the link
-- gone rather than working differently than it did yesterday, and the row is
-- the record of what was sent. Already-revoked rows keep their original time.
UPDATE invites SET revoked_at = now() WHERE revoked_at IS NULL;

DROP INDEX invites_list_idx;
ALTER TABLE invites DROP COLUMN list_id;
ALTER TABLE invites ALTER COLUMN space_id SET NOT NULL;
CREATE INDEX invites_space_idx ON invites (space_id);

/* ── The old membership table ────────────────────────────────────────────── */

-- Renamed rather than dropped. The roll-up above is lossy by design, and this
-- is the only record of what each person's role was per list before it ran.
-- Nothing reads it; a later migration can drop it once the merge has been lived
-- with for a while.
ALTER TABLE list_members RENAME TO list_members_legacy;
