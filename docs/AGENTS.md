# The agent workflow

Four agents work this backlog. Three write code in their own area; the fourth reviews and is
the only one allowed to merge.

```
GitHub issue                 development agent                reviewer
─────────────                ─────────────────                ────────
status:ready         ──►     claims it
                             status:in-progress
                             branches from main
                             writes test, then code
                             verifies, opens PR
                             status:pr_ready       ──►        reads issue + whole diff
                                                              runs the checks itself
                                                              ├─ holds up  → APPROVED, squash-merge
                                                              │              (issue closes)
                                                              └─ doesn't   → CHANGES REQUESTED
                             ◄────────────────────────────────   status:changes-requested
                             fixes, pushes same branch
                             status:pr_ready       ──►        …round again
```

## Agents

| Agent | Owns | Never touches |
|---|---|---|
| `frontend-agent` | `web/**` | `server/`, `shared/` |
| `backend-agent` | `server/**`, `shared/**` | `web/` |
| `infra-agent` | Docker, `.github/`, docs, root scripts | application code |
| `pr-reviewer` | reviews and merges | writes no application code |

Run one with the Agent tool, by name — for example *"run the backend-agent"*. Each takes a
single work item, carries it to a pull request, and stops. Run it again for the next one.

The three development agents own disjoint directories, so they can run at the same time
without conflicting. They coordinate through issues, never by editing each other's area: if
a frontend item needs an API change, it goes back on the backlog as a backend item.

## Labels

Every issue carries exactly one `area:` label and one `status:` label.

| Label | Meaning |
|---|---|
| `area:frontend` / `area:backend` / `area:infra` | which agent owns it |
| `status:ready` | available to pick up |
| `status:in-progress` | claimed by an agent right now |
| `status:pr_ready` | pull request open, waiting on review |
| `status:changes-requested` | reviewer pushed back; the owning agent picks it up again |
| `status:blocked` | a dependency isn't met — see the issue body |

> **The footgun:** updating an issue's labels **replaces the whole set**. Always send every
> label you want the issue to keep. Send only `status:in-progress` and the item silently
> loses its `area:` label, after which no agent will ever find it again.

## Branches

`agent/<area>/<issue-number>-<short-slug>` — for example `agent/backend/8-reorder-endpoint`.

Always branched from `origin/main`, never from another agent's branch. Rework is pushed to
the same branch so the open pull request updates rather than spawning a second one.

## The gate

A pull request merges when the reviewer leaves a comment beginning `APPROVED`. The reviewer
runs `typecheck`, both test suites and the build itself before saying so — a green
description in the pull request body is not evidence.

The reviewer will not merge:

- anything with a failing check;
- its own work;
- a change to the review gate itself — the reviewer definition, CI checks, or branch
  protection. Those get reviewed and left for a human, because an agent that can widen its
  own authority to merge is not a gate.

## Working agreements

- **Test first.** Write the failing test, then the code that passes it. The pure logic —
  period keys, stats, invite policy, the offline outbox, the SSE parser — is extracted into
  plain modules precisely so it can be tested directly.
- **Verify before handing off.** `npm run typecheck`, `npm test`, `npm run build`. All three.
- **Say what you didn't verify.** An agent that can't reach a database or a Docker daemon
  says so in the pull request rather than implying coverage it doesn't have.
- **Stay in scope.** Something else worth doing becomes a new issue, not a bigger diff.
  Unrelated changes hidden in a feature branch are a pushback, because they dodge review.
- **Disagree out loud.** A review is advice. An agent that thinks the reviewer is wrong says
  so on the thread with its reasoning — but answers every point rather than quietly ignoring
  one.
