---
description: Take the next area:infra work item to a pull request
argument-hint: "[issue number]"
---

Run the `infra-agent` subagent to take one infrastructure work item — Docker, Coolify, CI,
docs, repo scaffolding — through to a pull request.

Invoke it with the Agent tool using `subagent_type: "infra-agent"` and
**`run_in_background: false`**. Waiting matters: this command is designed to be run on a
loop, and a backgrounded agent would let the next tick start a second infra agent while the
first still holds a claimed issue and a half-finished branch.

Task for the agent:

$ARGUMENTS

If no issue number was given above, the agent follows its normal selection: issues labelled
`area:infra` and `status:changes-requested` first — work coming back from review outranks new
work — then `area:infra` + `status:ready`, oldest first.

When it finishes, report in a few lines:

- which issue it took, or that the backlog had nothing ready
- what it changed
- **what it actually ran and what it could not verify** — infrastructure is mostly not
  unit-testable, so this is the part that matters. An untested Dockerfile described as
  working is worse than one described as unbuilt.
- the pull request link, or why it stopped without one

Nothing ready is a perfectly good outcome — say so plainly and stop. Do not go looking for
work to invent, and do not merge anything: the `pr-reviewer` is the only agent that merges.
