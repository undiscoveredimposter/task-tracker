# Shared Daily Task Tracker — Implementation Plan

A shareable checklist app for recurring household tasks ("feed the cat"). Multiple people see
one list; anyone with access can tick a task off and everyone else sees it, live. Lists reset on
a configurable cadence.

Status: **plan agreed, awaiting UI mockup.** No implementation yet.

---

## 1. Decisions

These were chosen explicitly and the rest of the plan assumes them.

| Area | Decision |
|---|---|
| Auth | Firebase Auth — Google, email + password, and email magic link |
| Data store | Self-hosted Postgres, behind our own API. Firebase issues and signs tokens; it stores no task data |
| Hosting | Coolify — API + static frontend in one image, Postgres as a Coolify-managed database |
| Invites | Copy-link only. No transactional email provider, no domain/SPF/DKIM setup |
| Invite link scope | Anyone with the link can join (see §11 for the guardrails this needs) |
| Reset timing | Per-list IANA timezone + configurable reset hour, default 04:00 |
| Roles | Per-person: `owner` / `editor` / `viewer`, chosen at invite time |
| Completion UX | Shows who completed it and when, live; per-person stats and streaks |
| Frontend | Vite + React + TypeScript + Tailwind, shipped as an installable PWA |

## 2. Architecture

```
┌──────────────────────┐         ┌──────────────────────────────────┐
│  Firebase Auth       │         │  Coolify                         │
│  Google / pw / link  │         │  ┌────────────────────────────┐  │
└──────────┬───────────┘         │  │ app container              │  │
           │ ID token            │  │  Express API  +  static PWA │  │
           ▼                     │  └──────────┬─────────────────┘  │
┌──────────────────────┐  HTTPS  │             │ SQL                │
│  Browser (PWA)       │ ───────►│  ┌──────────▼─────────────────┐  │
│  React + Tailwind    │  SSE    │  │ Postgres (Coolify-managed) │  │
└──────────────────────┘ ◄───────│  └────────────────────────────┘  │
                                 └──────────────────────────────────┘
```

The browser gets a Firebase ID token, sends it as `Authorization: Bearer <token>`, and the API
verifies it with the Firebase Admin SDK on every request. Firebase never sees a task.

**Repo layout** (npm workspaces, one repo, one deployable image):

```
web/       Vite + React + Tailwind PWA
server/    Express + TypeScript API, Firebase Admin, pg
  migrations/   plain .sql files, applied on boot
shared/    types shared by both (Cadence, Role, DTOs)
docs/      this plan, deployment notes, design brief
Dockerfile          multi-stage: build web → build server → runtime
docker-compose.yml  what Coolify deploys
```

## 3. Data model

```sql
users            id, firebase_uid unique, email citext, display_name, photo_url,
                 created_at, last_seen_at

lists            id, name, emoji, color, owner_id → users,
                 timezone            -- IANA, e.g. 'Europe/London'
                 reset_hour          -- 0..23, default 4
                 cadence             -- 'daily'|'weekly'|'monthly'|'every_n_days'|'none'
                 cadence_interval    -- N, only for every_n_days
                 week_start          -- 1=Mon, only for weekly
                 cadence_anchor      -- date, only for every_n_days
                 created_at, archived_at

list_members     list_id, user_id, role 'owner'|'editor'|'viewer', joined_at
                 PK (list_id, user_id)

tasks            id, list_id, title, notes, position, created_by,
                 created_at, archived_at        -- soft delete, keeps stats honest

task_completions id, task_id, period_key, completed_by → users, completed_at
                 UNIQUE (task_id, period_key)   -- the whole reset mechanism

invites          id, list_id, token unique, role, invited_email nullable,
                 created_by, created_at, expires_at, max_uses, use_count,
                 revoked_at
```

Two things worth calling out:

**Nothing is ever "reset".** There is no nightly cron wiping checkboxes. A completion is stored
against a `period_key` — the identifier of the day/week/month it belongs to. Asking "is this done?"
means asking "is there a completion row for the *current* period_key?". When the clock rolls past
the reset hour, the current key changes and every task is implicitly unticked. A cron job would be
a thing that can fail at 4am; this cannot.

**`UNIQUE (task_id, period_key)`** makes ticking idempotent. That matters for §9: an offline device
replaying a queued tick can't create a duplicate, and two people tapping simultaneously can't race.

## 4. Period keys

Computed server-side only, so every device agrees. Given the list's timezone and reset hour:

```
effective = now.setZone(list.timezone).minus({ hours: list.reset_hour })
```

| Cadence | Key | Example |
|---|---|---|
| `daily` | `d:YYYY-MM-DD` | `d:2026-08-13` |
| `weekly` | `w:` + date of week start | `w:2026-08-10` |
| `monthly` | `m:YYYY-MM` | `m:2026-08` |
| `every_n_days` | `n<N>:` + floor(days since anchor / N) | `n3:214` |
| `none` | `static` — never resets, a plain checklist | `static` |

Subtracting the reset hour before formatting is what makes a 00:30 "fed the cat" count for the day
that just ended, rather than silently starting the next one. Luxon handles the DST edges.

## 5. API

All routes require a valid Firebase token. The user row is upserted from token claims on first
contact, so there's no separate registration step.

```
GET    /api/me
GET    /api/lists                        lists + today's progress for each
POST   /api/lists
GET    /api/lists/:id                    tasks, current period state, members
PATCH  /api/lists/:id                    name, emoji, cadence, timezone, reset hour
DELETE /api/lists/:id

POST   /api/lists/:id/tasks
PATCH  /api/tasks/:id                    title, notes, position
DELETE /api/tasks/:id                    soft delete

POST   /api/tasks/:id/complete           period computed server-side, idempotent
DELETE /api/tasks/:id/complete           untick

GET    /api/lists/:id/stats?window=30    per-person counts, streaks, completion rate

POST   /api/lists/:id/invites            { role } → { token, url }
GET    /api/invites/:token               preview: list name, inviter, role (no auth)
POST   /api/invites/:token/accept
DELETE /api/invites/:id                  revoke
GET    /api/lists/:id/members
PATCH  /api/lists/:id/members/:userId    change role
DELETE /api/lists/:id/members/:userId    remove, or leave if it's yourself

GET    /api/stream                       SSE, all lists you're a member of
GET    /api/health                       for Coolify's healthcheck
```

**Role enforcement**, checked in middleware on every list-scoped route:

| | viewer | editor | owner |
|---|---|---|---|
| Tick / untick tasks | ✅ | ✅ | ✅ |
| Add / rename / delete tasks | — | ✅ | ✅ |
| Invite others, change roles | — | — | ✅ |
| Change cadence & settings | — | — | ✅ |
| Delete the list | — | — | ✅ |

Editors deliberately *cannot* invite — sharing stays with the owner. Say if you'd rather they could.

## 6. Realtime

`GET /api/stream` holds an SSE connection per signed-in device. The server keeps an in-memory map
of `userId → connections`; any mutation looks up that list's members and pushes
`{ type: 'task.completed', listId, taskId, by, at }` to each connected member. Client applies it to
local state — no refetch. Reconnect with backoff, and refetch the list on reconnect to close any gap.

SSE over WebSockets because the traffic is one-directional (writes go over normal HTTP) and SSE
survives proxies and reconnects on its own.

This assumes **one app instance**. Running two containers behind Coolify's proxy would mean a tick
on instance A doesn't reach a listener on instance B. If that day comes, swap the in-memory map for
Postgres `LISTEN`/`NOTIFY` — roughly 30 lines, no API change. Noting it now so it isn't a surprise.

## 7. Auth flow

1. Frontend signs in via Firebase (Google popup, password, or magic link).
2. Firebase returns an ID token; frontend attaches it to every request and refreshes it hourly.
3. API verifies the token with Firebase Admin — signature, expiry, audience — then upserts
   `users` on `firebase_uid`.
4. Sign-out clears local state and closes the SSE stream.

Magic link needs no email provider of our own: Firebase sends it from its own domain. The cost is
that the sender reads `noreply@<project>.firebaseapp.com`, which looks slightly off-brand — fixable
later with a custom domain if it bothers you. Both the app domain and the Firebase auth domain must
be added to Firebase's **Authorized domains**, or sign-in fails in production only.

## 8. Sharing flow

1. Owner opens Share, picks a role (viewer or editor), taps **Create invite link**.
2. API returns `https://<app>/invite/<token>`. Owner copies it and sends it however they like.
3. Recipient opens it. Signed out → sign-in screen, then straight back to the invite. Signed in →
   "Alex invited you to **Home** as an editor" → Join.
4. Accepting inserts a `list_members` row and increments `use_count`.

The optional `invited_email` field is kept on the invite for display only ("invited alex@…"), since
you chose links that aren't email-locked.

## 9. PWA & offline

- `vite-plugin-pwa`, generated service worker, app shell precached.
- Manifest: name, icons (192/512 + maskable), `display: standalone`, theme color, portrait.
- iOS: apple-touch-icon, `viewport-fit=cover`, and `env(safe-area-inset-*)` padding so the header
  and bottom actions clear the notch and home indicator.
- Custom install prompt from `beforeinstallprompt`, plus a short "Add to Home Screen" hint for iOS
  Safari, which doesn't fire that event.
- Ticking is optimistic: UI updates instantly, request queues if offline, replays on reconnect.
  Safe because of the unique constraint in §3. An offline banner shows queued-change count.
- Lists and tasks are cached for read-only viewing offline.

## 10. Deployment (Coolify)

- New **Docker Compose** resource pointed at this repo and branch; Coolify builds on push.
- Postgres as a **Coolify-managed database** rather than a compose service, so automated backups
  and retention are handled for you. `DATABASE_URL` is injected as an env var.
- Migrations run on container boot, before the server listens.
- Healthcheck `GET /api/health`; Coolify handles TLS and the domain.

**Server env:** `DATABASE_URL`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
`FIREBASE_PRIVATE_KEY`, `APP_ORIGIN`, `PORT`.

**Web env (build-time):** `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
`VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`.

Vite inlines `VITE_*` at **build** time, not runtime — they must be set as Coolify **build
variables**, not just runtime env, or the frontend ships with undefined config. This is the single
most common way this deploy goes wrong. (These values are public by design; the private service
account key is server-side only and must never reach `web/`.)

## 11. Flagged risks

1. **"Anyone with the link" invites.** Your call and the plan follows it, but a link pasted into a
   group chat is a stranger with tick access. I'll ship three guardrails that keep the frictionless
   behaviour: links expire after 7 days by default, are revocable at any time, and have an optional
   max-use count. Tell me if you'd rather they never expired.
2. **Timezone changes mid-period.** Editing a list's timezone or reset hour changes the current
   period key, so today's ticks appear to vanish (the old rows survive; they're just keyed to the
   old period). I'll warn in the settings UI before saving.
3. **Single instance for SSE** — §6.
4. **Firebase authorized domains** — §7. Fails only in production, so it's easy to miss.

## 12. Build order

| | Milestone | Contents |
|---|---|---|
| M0 | Scaffold | Workspaces, TS config, Tailwind, Docker, compose, healthcheck |
| M1 | Auth | Firebase client + Admin verification, user upsert, sign-in screen |
| M2 | Core | Lists, tasks, period keys, tick/untick — the app works solo |
| M3 | Sharing | Invites, accept flow, roles, member management |
| M4 | Live | SSE, optimistic updates, "done by Alex 8:12am" |
| M5 | Stats | Per-person contributions, streaks, completion rate |
| M6 | PWA | Manifest, service worker, offline queue, install prompt |
| M7 | Deploy | Coolify walkthrough, Firebase setup guide, README |
| M8 | Tests | Period-key unit tests (DST, week starts, leap), role-permission tests, API integration |

Period-key logic gets real unit tests — DST transitions and week boundaries are where a checklist
app quietly lies to you about whether the cat was fed.

---

## 13. Design brief — screens to mock up

Mobile-first at 375px, scaling to desktop. Light and dark. Tailwind tokens. Minimum 44px tap
targets; primary actions in thumb reach at the bottom of the screen.

1. **Sign in** — Google button, email + password, "email me a link" toggle. First-run explainer.
2. **Lists home** — card per list: emoji, name, progress ring (`3/5 today`), cadence chip, member
   avatars, time until reset. Empty state for a brand-new account. New-list button.
3. **List detail** — *the screen that matters.* Header with progress and reset countdown; task rows
   with a large checkbox, title, and completed subtext ("Alex · 8:12am"); tap to tick with an undo
   affordance; add-task button for editors; empty state; offline banner.
4. **Task editor** — bottom sheet: title, notes, delete, drag-reorder handle.
5. **List settings** — name, emoji, colour, timezone picker, cadence picker (daily / weekly /
   monthly / every N days / never), reset-hour picker with a plain-language preview
   ("resets at 4:00am — tasks done after midnight still count for the previous day"), danger zone.
6. **Share sheet** — role picker, Create link, copy button with copied confirmation, list of active
   invites with revoke, member list with role change and remove.
7. **Invite landing** — signed out and signed in variants; plus expired / revoked / already-a-member.
8. **Stats** — per-person contribution over 7/30 periods, current streak, completion rate.
9. **System states** — loading skeletons, error, offline, PWA install prompt, iOS add-to-home hint.

The heart of it is one interaction: a tired person, one-handed, at 7am, ticking off the cat. Every
other screen can be plain. That one should feel instant and satisfying.
