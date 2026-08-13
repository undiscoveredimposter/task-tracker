-- Tally: initial schema.
--
-- The load-bearing idea is `task_completions.period_key`: a tick is stored
-- against the identifier of the day/week/month it belongs to, and "is this done?"
-- means "is there a row for the CURRENT period key?". Lists therefore reset
-- implicitly when the clock rolls past the reset hour — there is no cron job to
-- fail at 4am — and the history needed for stats survives every reset.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid  text NOT NULL UNIQUE,
  email         text,
  display_name  text NOT NULL DEFAULT '',
  photo_url     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

-- Emails arrive from Firebase already normalised, but invites and lookups
-- compare on this, so keep it case-insensitive at the index level.
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE lists (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  emoji                 text NOT NULL DEFAULT '🏠',
  color                 text NOT NULL DEFAULT '#9184d9',
  owner_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timezone              text NOT NULL DEFAULT 'Europe/London',
  reset_hour            smallint NOT NULL DEFAULT 4 CHECK (reset_hour BETWEEN 0 AND 23),
  cadence               text NOT NULL DEFAULT 'daily'
                          CHECK (cadence IN ('daily', 'weekly', 'monthly', 'every_n_days', 'none')),
  cadence_interval_days smallint NOT NULL DEFAULT 3 CHECK (cadence_interval_days BETWEEN 2 AND 365),
  week_start            smallint NOT NULL DEFAULT 1 CHECK (week_start BETWEEN 1 AND 7),
  -- Fixed point the every_n_days cycle counts from, so the phase of the cycle
  -- survives edits to unrelated settings.
  cadence_anchor        date NOT NULL DEFAULT CURRENT_DATE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz
);

CREATE TABLE list_members (
  list_id   uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, user_id)
);

CREATE INDEX list_members_user_idx ON list_members (user_id);

CREATE TABLE tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id     uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  title       text NOT NULL,
  notes       text,
  -- Float so a task can always be dropped between two others without a rewrite.
  position    double precision NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Soft delete: removing a task must not silently rewrite past stats.
  archived_at timestamptz
);

CREATE INDEX tasks_list_idx ON tasks (list_id) WHERE archived_at IS NULL;

CREATE TABLE task_completions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  period_key   text NOT NULL,
  completed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  -- Makes ticking idempotent: an offline device replaying a queued tick, or two
  -- people tapping the same row at once, cannot produce a duplicate.
  UNIQUE (task_id, period_key)
);

CREATE INDEX task_completions_period_idx ON task_completions (period_key);

CREATE TABLE invites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id    uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  token      text NOT NULL UNIQUE,
  role       text NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  max_uses   integer CHECK (max_uses IS NULL OR max_uses > 0),
  use_count  integer NOT NULL DEFAULT 0,
  revoked_at timestamptz
);

CREATE INDEX invites_list_idx ON invites (list_id);
