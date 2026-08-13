# Tally

A shared household checklist. One list, several people, live: someone ticks off
"feed the cat" and everyone else sees it done, by whom, when. The list clears
itself on a cadence you choose — daily, weekly, monthly, every N days, or never.

Installable as a PWA, so it sits on a home screen and opens like an app.

- **Auth** — Firebase (Google, email + password, email magic link)
- **Data** — your own Postgres, behind your own API. Firebase issues tokens; it
  never sees a task
- **Hosting** — [Coolify](https://coolify.io): one image serving the API and the
  built PWA, plus a Coolify-managed Postgres

Full design rationale is in [docs/PLAN.md](docs/PLAN.md); deployment is in
[docs/DEPLOY.md](docs/DEPLOY.md).

---

## The one idea worth understanding

**Nothing is ever reset.** There is no nightly job that wipes checkboxes.

A completion is stored against a **period key** — the identifier of the day,
week or month it belongs to (`d:2026-08-13`, `w:2026-08-10`, `m:2026-08`).
"Is this done?" means "is there a completion row for the *current* period key?".
When the clock passes the list's reset hour the current key changes and every
task is implicitly unticked, without anything having run.

The key is computed server-side from the list's IANA timezone and reset hour, so
every device agrees, and the reset hour is subtracted before formatting:

```
effective = now.setZone(list.timezone).minus({ hours: list.reset_hour })
```

That last part is why a 00:30 "fed the cat" counts for the day that just ended
rather than quietly starting the next one. Default reset hour is 04:00.

`UNIQUE (task_id, period_key)` makes ticking idempotent, which is what lets an
offline device replay a queued tick and two people tap at the same moment
without either creating a duplicate.

A cron job is a thing that can fail at 4am. This cannot.

---

## Repository layout

```
web/          Vite + React + TypeScript + Tailwind PWA
server/       Express + TypeScript API — Firebase Admin, pg
  migrations/   plain .sql, applied on boot before the port opens
shared/       types used by both (Cadence, Role, DTOs)
docs/         PLAN.md, DEPLOY.md, DESIGN_BRIEF.md, AGENTS.md
Dockerfile              multi-stage: build web → build server → runtime
docker-compose.yml      what Coolify deploys (no database service — see DEPLOY.md)
docker-compose.local.yml  the same image plus a throwaway Postgres, for a laptop
```

npm workspaces, one repo, one deployable image. Node 22 or newer.

---

## Running it locally

### 1. Install

```bash
npm install
npm run build -w @tally/shared    # server/ and web/ resolve it through shared/dist
```

### 2. Start a Postgres

Any Postgres 16 will do. With Docker:

```bash
docker run -d --name tally-db -p 5432:5432 \
  -e POSTGRES_USER=tally -e POSTGRES_PASSWORD=tally -e POSTGRES_DB=tally \
  postgres:16-alpine
```

Or point `DATABASE_URL` at one you already have. Migrations run automatically
when the server boots, so there is no setup step.

### 3. Configure

```bash
cp .env.example .env          # gitignored
```

`.env.example` documents every variable, which are secret, and — importantly —
which are read at *build* time rather than runtime. For local work the defaults
are fine; set `DATABASE_URL` to your database and `TALLY_DEV_AUTH=1` to work
without a Firebase project.

Nothing loads that file implicitly — there is no `dotenv` in the dependency
tree. Node reads it when you ask it to, with `--env-file`, which is how the
commands below start the server.

### 4. Run the API

```bash
npm run build -w @tally/shared -w @tally/server
node --env-file=.env server/dist/index.js
```

It applies migrations, then listens on `:8080`:

```
[migrate] applying 001_init.sql
[auth] TALLY_DEV_AUTH is on — any "Bearer dev:<uid>:<email>" token is accepted.
[tally] listening on :8080 (development)
```

> **`npm run dev -w @tally/server` does not currently start** — it fails with
> `Cannot find module …/src/app.js`, because Node does not rewrite the `.js`
> specifiers that `module: NodeNext` requires the source to be written with.
> Tracked in [#33](https://github.com/undiscoveredimposter/task-tracker/issues/33);
> until it is fixed, build and run as above.

### 5. Run the frontend

In a second terminal:

```bash
npm run dev -w @tally/web
```

Vite serves the app on <http://localhost:5173> and proxies `/api` to
`http://localhost:8080` (override with `API_ORIGIN`), so the browser sees one
origin exactly as it does in production.

### Working without a Firebase project

`TALLY_DEV_AUTH=1` makes the API accept `Bearer dev:<uid>:<email>` in place of a
real Firebase ID token — enough to build and test the whole API with nothing but
curl:

```bash
TOKEN='dev:alex:alex@example.test'
curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/me
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"name":"Home","emoji":"🏠","cadence":"daily","timezone":"Europe/London"}' \
     localhost:8080/api/lists
```

The user row is created from the token on first contact; there is no
registration step.

Two limits worth knowing. It is **double-gated** — it needs the opt-in *and* a
non-production `NODE_ENV`, and the deployed image bakes in `NODE_ENV=production`,
so it cannot be switched on in a container. And the **browser UI has no
dev-token path**: signing in through the web app needs real Firebase config, so
for frontend work follow the Firebase setup in
[docs/DEPLOY.md](docs/DEPLOY.md#2-set-up-firebase) and put the four `VITE_*`
values in `web/.env.local`.

### Serving the built PWA from the API

What production does — one process, one origin, no proxy:

```bash
npm run build
DATABASE_URL=postgresql://tally:tally@127.0.0.1:5432/tally \
TALLY_DEV_AUTH=1 \
APP_ORIGIN=http://localhost:8080 \
WEB_ROOT="$PWD/web/dist" \
node server/dist/index.js
```

The whole app is then on <http://localhost:8080>.

> **`WEB_ROOT` must be an absolute path.** Give it a relative one and the
> failure is split in half: assets serve fine, but every page navigation
> returns `500 path must be absolute or specify root to res.sendFile`. The
> deployed image sets an absolute path, so this only bites locally. Tracked in
> [#36](https://github.com/undiscoveredimposter/task-tracker/issues/36).

### The whole stack in Docker

```bash
docker compose -f docker-compose.local.yml up --build
curl localhost:8080/api/health      # {"ok":true,"streams":0}
```

That file is **not** what Coolify deploys — it adds a throwaway Postgres so the
image can be exercised on a laptop. Production uses `docker-compose.yml`, which
deliberately has no database service.

---

## Tests

```bash
npm run typecheck    # shared, then server and web
npm test             # server (node --test) and web (vitest)
npm run build        # all three workspaces
```

All three run in CI on every pull request.

The server suite covers period keys — DST transitions, week starts, leap years,
the boundaries where a checklist app quietly lies to you about whether the cat
was fed — plus invite policy and stats as pure functions, and role enforcement
and the API end to end against a **real Postgres**.

Those integration suites need a database. Without `DATABASE_URL` they skip
themselves and say so:

```bash
npm run test:db      -w @tally/server    # throwaway Postgres on :55433, full suite
npm run test:db:down -w @tally/server    # stop it, forget everything
```

Or point at your own:

```bash
DATABASE_URL=postgresql://tally:tally@127.0.0.1:5432/tally_test npm test
```

CI does exactly this and then **fails the run if any suite skipped itself** — a
skipped suite still exits 0, so a `DATABASE_URL` that stopped reaching the
database would otherwise go back to reporting green without touching Postgres.

Test-first is the working agreement: the pure logic — period keys, stats,
invite policy, the offline outbox, the SSE parser — is extracted into plain
modules precisely so it can be tested directly. See
[docs/AGENTS.md](docs/AGENTS.md).

---

## Deploying

[docs/DEPLOY.md](docs/DEPLOY.md) is the walkthrough: Coolify resource, managed
Postgres, Firebase setup, and the environment variables.

The one thing to carry into it: **`VITE_*` variables are inlined at build time.**
They must be Coolify *build* variables. Set only as runtime environment, the
frontend ships with undefined Firebase config and nobody can sign in.

---

## Known `npm audit` finding

`npm audit` reports 6 moderate advisories, all the same one:

```
uuid <11.1.1  — missing buffer bounds check in v3/v5/v6 when `buf` is provided
  gaxios → teeny-request → @google-cloud/storage → firebase-admin
```

`firebase-admin` pulls `@google-cloud/storage` in as a mandatory dependency and
that is what depends on the vulnerable `uuid`. **Tally does not use Cloud
Storage**, and the advisory only applies when a caller passes its own buffer to
`uuid` — a code path nothing here reaches.

There is no fixed `firebase-admin` release to move to. `npm audit fix --force`
"resolves" it by downgrading to `firebase-admin@10.3.0`, a major version
backwards, which is worse. So it is accepted and recorded here rather than
silently suppressed; revisit when `firebase-admin` ships an updated
`@google-cloud/storage`.

---

## Contributing

Four agents work this backlog against GitHub issues, and the labelling and
branch conventions they follow are in [docs/AGENTS.md](docs/AGENTS.md).

Before opening a pull request: `npm run typecheck`, `npm test`, `npm run build`.
All three. And say what you could not verify.
