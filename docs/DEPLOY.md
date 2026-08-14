# Deploying Tally on Coolify

From nothing to a working deployment. Read [§10 of PLAN.md](PLAN.md#10-deployment-coolify)
first if you want the reasoning; this is the procedure.

What you end up with:

```
Coolify project
├── app          Docker Compose resource built from this repo
│                one container: Express API + the built PWA
└── postgres     Coolify-managed database, backed up by Coolify
```

**The one thing that will bite you.** Vite inlines `VITE_*` variables into the
JavaScript bundle when the image is *built*. They must be set as Coolify **build
variables**. Set only as runtime environment they arrive after the bundle is
already written: the app deploys, the healthcheck passes, the server logs
nothing wrong, and every sign-in fails. If you read one line of this document,
read [step 4](#4-set-the-environment-variables).

> Coolify's UI shifts between versions, so treat the labels below as
> descriptions rather than exact strings. What each step needs to achieve does
> not change.

---

## Before you start

- A Coolify instance with a server attached, and a domain (or subdomain) whose
  DNS points at it. Coolify issues TLS itself.
- A Google account, for Firebase.
- Push access to this repository, and Coolify able to read it (public repo, or a
  GitHub App / deploy key configured in Coolify).

---

## 1. Create the managed Postgres

**New Resource → Database → PostgreSQL 16.** Put it in the same Coolify
**project** as the app will go in.

A Coolify-managed database rather than a `postgres` service in the compose file,
because Coolify then owns backups and retention. That is also why
`docker-compose.yml` has no database service in it — adding one would give you a
second, unbacked-up database quietly shadowing the real one.

Once it starts, copy its **internal** connection URL. It looks like:

```
postgresql://postgres:<generated-password>@<service-name>:5432/postgres
```

Internal, not the public one: the app talks to it over Coolify's private
network. Do not expose the database publicly unless you actually need to.

**Turn on scheduled backups now**, while you remember. The whole point of using
the managed database is that someone else runs `pg_dump` for you.

---

## 2. Set up Firebase

Firebase issues and signs the tokens. It stores no task data.

### Create the project and web app

1. <https://console.firebase.google.com> → **Add project**. Analytics is
   unnecessary.
2. **Project settings → General → Your apps → Web (`</>`)**. Register an app.
3. Copy the config object it shows you. You need four of its values:

   | Firebase config | Variable |
   |---|---|
   | `apiKey` | `VITE_FIREBASE_API_KEY` |
   | `authDomain` | `VITE_FIREBASE_AUTH_DOMAIN` |
   | `projectId` | `VITE_FIREBASE_PROJECT_ID` |
   | `appId` | `VITE_FIREBASE_APP_ID` |

   These are **public by design**. They identify the project, they authorise
   nothing, and they ship inside the JavaScript bundle whatever you do. Access
   is controlled by Firebase and by this API. Do not confuse them with the
   service account key below, which is a real secret.

### Enable the sign-in methods

**Authentication → Sign-in method**, enable all three:

- **Google** — pick a support email.
- **Email/Password** — and, in the same panel, tick **Email link (passwordless
  sign-in)**. Tally offers both.

Firebase sends the magic-link email itself, so Tally needs no email provider,
no domain, no SPF or DKIM. The cost is that it arrives from
`noreply@<project>.firebaseapp.com` until you configure a custom domain.

### Add your domain to Authorized domains

**Authentication → Settings → Authorized domains → Add domain**, and add the
domain you will serve Tally from (`tally.example.com`).

Miss this and everything works locally and in review, then sign-in fails in
production only, with `auth/unauthorized-domain` in the browser console and
nothing whatsoever in the server logs. It is
[flagged risk #4 in the plan](PLAN.md#11-flagged-risks) for that reason.

### Download the service account key

**Project settings → Service accounts → Generate new private key.** This
downloads a JSON file. You need three fields from it:

| JSON field | Variable |
|---|---|
| `project_id` | `FIREBASE_PROJECT_ID` |
| `client_email` | `FIREBASE_CLIENT_EMAIL` |
| `private_key` | `FIREBASE_PRIVATE_KEY` |

**This one is a genuine secret.** It goes into Coolify's runtime environment and
nowhere else — never into the repository, never into a build argument, never
anywhere `web/` can reach. Anyone holding it can mint tokens for any user.

---

## 3. Create the application resource

**New Resource → Docker Compose** (the "from a Git repository" flavour), in the
same project as the database.

| Field | Value |
|---|---|
| Repository | this repo |
| Branch | `main` |
| Compose file | `docker-compose.yml` |
| Base directory | `/` |

`docker-compose.yml` builds the `Dockerfile` at the repository root. Coolify
builds on push once the webhook is in place.

**Network.** The app and the database must share a network for the internal
`DATABASE_URL` hostname to resolve. Keeping both in one project usually arranges
this; if the app cannot reach the database, look for a "connect to predefined
network" toggle on one or both resources and enable it.

**Domain.** Set the app's FQDN (`https://tally.example.com`) on the `app`
service. Coolify terminates TLS and routes to port 8080, which is what the
container exposes. The app trusts Coolify's forwarded headers.

---

## 4. Set the environment variables

Two groups, and the distinction is the whole ballgame. Coolify's environment
editor has a per-variable **Build Variable** toggle (older versions have a
separate "Build Variables" section). `VITE_*` need it on. Everything else does
not.

### Runtime — the server reads these when it starts

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | internal URL from step 1 | required; the server refuses to start without it |
| `APP_ORIGIN` | `https://tally.example.com` | builds invite links (`<APP_ORIGIN>/j/<token>`). No trailing slash |
| `FIREBASE_PROJECT_ID` | from the service account JSON | |
| `FIREBASE_CLIENT_EMAIL` | from the service account JSON | |
| `FIREBASE_PRIVATE_KEY` | from the service account JSON | **secret**; see below |
| `INVITE_DEFAULT_DAYS` | `7` | optional; `0` means links never expire |
| `RATE_LIMIT_INVITE_LOOKUPS_PER_MINUTE` | `20` | optional; unauthenticated invite-link lookups, per client address |
| `RATE_LIMIT_WRITES_PER_MINUTE` | `240` | optional; authenticated writes, per signed-in person |

Both rate limits must be **above zero**. The server refuses to start on a `0` or
a typo rather than booting into a wall of 429s nobody can explain, so a bad
value shows up as a failed deploy, not a mysteriously broken app. The counters
live in the process's memory, which is another reason to
[run one instance](#run-one-instance). `GET /api/health` is never limited — a
429 there would read as a sick container and take the app out of rotation.

The defaults suit a household and most deployments never touch them. Raise
`RATE_LIMIT_INVITE_LOOKUPS_PER_MINUTE` if several people share one outbound
address (an office NAT) and hit "Too many invite links tried from here".

`NODE_ENV=production`, `PORT=8080` and `WEB_ROOT` are baked into the image and
set again in the compose file. Leave them alone —
[see below](#node_envproduction-is-a-security-control).

**`FIREBASE_PRIVATE_KEY`** is a multi-line PEM. Coolify stores it with literal
`\n` escapes and the server unescapes them, so paste it either as the raw
multi-line block or as the single line with `\n` in it — both work. What must
survive is the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`
lines. Mark it as a secret so it is masked in the UI.

### Build — inlined into the frontend bundle

Set all four **with the build-variable toggle on**:

```
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_APP_ID
```

They are passed to the web build stage as `--build-arg` by
`docker-compose.yml`. The build itself prints a loud warning when they are
missing:

```
################################################################
# WARNING: building the PWA with no Firebase config.
# VITE_FIREBASE_API_KEY / VITE_FIREBASE_PROJECT_ID are empty.
# Vite inlines these at build time, so this image can never
# sign anyone in. Pass them as --build-arg / Coolify build vars.
################################################################
```

If that appears in your deploy log, the image you just built cannot sign anyone
in. Fix the variables and rebuild — restarting will not help, because the bundle
is already written.

Changing a `VITE_*` value later requires a **rebuild**, not a restart.

`.env.example` in the repository root lists every variable with its shape.

---

## 5. Deploy

Hit **Deploy** and watch the log. A healthy first deploy shows, in order:

```
[migrate] applying 001_init.sql
[migrate] up to date (1 migration(s))
[auth] verifying Firebase ID tokens for project your-project
[tally] listening on :8080 (production)
```

Migrations run inside the server process **before the port opens**, so a deploy
never serves traffic against a schema it does not expect, and there is
deliberately no separate migration step or job to run. Concurrent boots
serialise on a Postgres advisory lock.

Then check it from outside:

```bash
curl https://tally.example.com/api/health
# {"ok":true,"streams":0}
```

`ok:true` means the process is up *and* its database round-trip worked;
`{"ok":false}` with 503 means the app is running but cannot reach Postgres.
Coolify uses the same endpoint for its container healthcheck — 15s interval,
30s start period to cover migrations.

Finally, open the site and sign in. That is the only test that exercises the
`VITE_*` variables.

---

## 6. Afterwards

**Logs.** Coolify's resource view has the container's stdout — deploy logs
under the deployment, runtime logs under **Logs**. The app logs to stdout only
and does not write log files. The compose file caps them at 3 × 10 MB.

**Updates.** Push to `main`; the webhook rebuilds. Watch that the migration
lines appear again in the deploy log.

**Backups.** On the database resource, not the app. Restoring means restoring
Postgres — the app container holds no state at all.

---

## Things that will trip you up

### `NODE_ENV=production` is a security control

`server/src/firebase.ts` has a development auth bypass that accepts
`Bearer dev:<uid>:<email>` in place of a real Firebase token. It is double-gated
on `TALLY_DEV_AUTH=1` **and** a non-production `NODE_ENV`, and the image sets
`NODE_ENV=production`, so it cannot be switched on in a deployed container.

Do not "fix" a problem by setting `NODE_ENV=development` in Coolify. That turns
one environment variable into an unauthenticated login for anyone who guesses
the format. Never set `TALLY_DEV_AUTH` on a deployed environment either.

### Do not put a buffering proxy in front of `/api/stream`

Live updates are Server-Sent Events over one long-lived HTTP connection per
signed-in device. A proxy that buffers responses or times idle connections out
aggressively will not error — it will simply make live updates appear not to
work, while every other request looks fine. Coolify's default proxy handles this
correctly; the trap is adding your own Nginx or Cloudflare rule in front and
enabling response buffering.

The container gets a 30-second stop grace period so those connections close
cleanly on shutdown instead of being killed mid-write.

### Run one instance

SSE subscribers are held in memory in the process. Two containers means a tick
on one does not reach a listener on the other. Scaling out needs Postgres
`LISTEN`/`NOTIFY` first — [PLAN.md §6](PLAN.md#6-realtime), tracked as its own
issue. Until then, one replica.

### Invite links are "anyone with the link"

By design ([PLAN.md §11](PLAN.md#11-flagged-risks)). The guardrails are that
links expire after `INVITE_DEFAULT_DAYS` (7 by default), can be revoked at any
time, and can carry a max-use count. Set `INVITE_DEFAULT_DAYS=0` only if you
genuinely want links that never expire.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Sign-in does nothing; console says Firebase config is undefined | `VITE_*` set as runtime env instead of **build** variables. Rebuild, do not restart |
| `auth/unauthorized-domain` on sign-in, production only | The domain is missing from Firebase → Authentication → Settings → **Authorized domains** |
| Container restarts; `Missing required environment variable DATABASE_URL` | Not set, or not visible to the `app` service |
| Healthcheck fails, `{"ok":false,"error":"database unavailable"}` | The app is up but cannot reach Postgres — usually the two resources are not on a shared network, or the URL is the public one from outside |
| `Failed to parse private key` / auth fails for every user | `FIREBASE_PRIVATE_KEY` truncated or missing its BEGIN/END lines |
| Invite links point at the wrong host | `APP_ORIGIN` wrong or unset; it defaults to `http://localhost:5173` |
| Ticks only appear after a refresh | SSE is being buffered by a proxy in front of Coolify, or more than one replica is running |
| `429` with `{"code":"rate_limited"}` and a `Retry-After` header | A rate limit is doing its job. On invite links, several people behind one outbound address — raise `RATE_LIMIT_INVITE_LOOKUPS_PER_MINUTE`. On writes, it is per signed-in person, so it usually means a client retry loop rather than a real user |
| Container will not start; `RATE_LIMIT_… must be a positive number` | One of the two limits is `0` or not a number. Set it above zero or remove it to take the default |
| Deploy log shows the "no Firebase config" warning banner | The build had no `VITE_*` values. That image can never sign anyone in |

---

## Deploying somewhere else

Nothing here is Coolify-specific except the UI. Any host that can build a
Dockerfile works, provided it:

1. passes the four `VITE_*` values as **build arguments**;
2. provides `DATABASE_URL` to a Postgres 16 and the Firebase Admin variables at
   runtime;
3. keeps `NODE_ENV=production`;
4. healthchecks `GET /api/health` with a start period long enough for
   migrations;
5. does not buffer `/api/stream`;
6. runs a single instance.

To try the image locally first, `docker-compose.local.yml` runs it against a
throwaway Postgres:

```bash
docker compose -f docker-compose.local.yml up --build
curl localhost:8080/api/health
```
