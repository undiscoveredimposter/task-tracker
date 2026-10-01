# Contributing

This backlog is worked by Claude Code agents against GitHub issues — one issue, one
branch, one pull request — with a reviewer as the only role allowed to merge.

**[docs/AGENTS.md](docs/AGENTS.md) is the source of truth for that workflow.** This file
exists because GitHub surfaces it from the new-issue and new-pull-request pages, which is
where someone actually needs it. It routes; it does not restate.

| What you need | Where it is |
|---|---|
| The label lifecycle, and the footgun that a label update replaces the **whole** set | [docs/AGENTS.md § Labels](docs/AGENTS.md#labels) |
| Branch naming — `agent/<area>/<issue-number>-<slug>`, always cut from `origin/main` | [docs/AGENTS.md § Branches](docs/AGENTS.md#branches) |
| Who owns which directory, and what each agent never touches | [docs/AGENTS.md § Agents](docs/AGENTS.md#agents) |
| When a pull request may merge, and the three things the reviewer will not merge | [docs/AGENTS.md § The gate](docs/AGENTS.md#the-gate) |
| Getting it running, and the test suites that need a real Postgres | [README.md § Running it locally](README.md#running-it-locally) |
| Why nothing is ever "reset" — read this before touching completions | [README.md](README.md#the-one-idea-worth-understanding) |
| Deploying, and the `VITE_*` build-time trap that breaks sign-in in production only | [docs/DEPLOY.md](docs/DEPLOY.md) |

## Before every hand-off

```bash
npm run typecheck    # builds @tally/shared first — server/ and web/ resolve it via shared/dist
npm test             # server: node --test  ·  web: vitest
npm run build
```

All three, every time, including for a change that only touches documentation. CI runs
the same three on every pull request, so a red one costs a review round that a minute
locally would have saved.

## Two rules that are not negotiable

1. **You do not merge your own work.** A pull request merges when the reviewer leaves a
   comment beginning `APPROVED` — no matter how small the change is.
2. **Say what you could not verify.** No Docker daemon, no registry access, no Coolify,
   no real Firebase project, a workflow that can only run for real once merged: name it
   in the pull request. An untested artefact described as verified is the exact failure
   this process exists to catch.

## Secrets

`.env.example` carries variable names and shapes only — never a real key, connection
string, or service account. If you find a credential already committed, raise it rather
than quietly deleting it: it is still in the history and needs rotating.
