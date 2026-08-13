# Tally

A shared household checklist that resets on a cadence you choose. npm workspaces, one repo,
one deployable image.

| Workspace | What it is |
|---|---|
| `shared/` | Types shared across the wire. Must be **built** before either typecheck runs. |
| `server/` | Express 5 API on Postgres, SSE for live updates, Firebase auth. |
| `web/` | React 19 PWA, Vite, Tailwind 4. |

## Checks

Run all three before handing work off:

```
npm run typecheck
npm test
npm run build
```

`npm run typecheck` builds `@tally/shared` first — `server/` and `web/` both resolve it
through `shared/dist`, so on a fresh clone the typechecks fail with
`Cannot find module '@tally/shared'` until that build has happened.

Server tests are `node --test` (Node 22 type stripping, no database needed). Web tests are
vitest. Narrow to one workspace with `npm test -w @tally/server` or `-w @tally/web`.

## The one idea to understand first

Lists reset without anything ever running on a schedule. A completion is stored against a
**period key** derived from the list's timezone and reset hour, and "is this done?" means
"is there a row for the key of the period we're in right now?". Past the reset hour the key
changes and every task is implicitly outstanding again.

The period key is computed server-side and never sent by the client, and
`UNIQUE (task_id, period_key)` is what makes completing idempotent — which is what lets the
web client safely replay ticks queued while offline. Don't weaken either.

## Where to read more

- `docs/PLAN.md` — data model (§3), period keys (§4), realtime (§6)
- `docs/AGENTS.md` — the four-agent backlog workflow and who owns which directory
- `docs/DESIGN_BRIEF.md` — the UI the screens were built against

## Environment

`.claude/hooks/session-start.sh` installs dependencies and builds `shared/` when a Claude
Code on the web session starts, so the checks above work immediately. It is a no-op on local
checkouts.

`.github/workflows/ci.yml` runs the same three checks on every pull request and on pushes to
`main`. Run them locally before handing work off anyway — a red pull request costs a review
round.
