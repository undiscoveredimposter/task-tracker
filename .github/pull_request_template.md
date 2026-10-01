<!--
Pre-filled from .github/pull_request_template.md. Delete what does not apply — but do
not delete "Verification" or "What I could not verify". Those two are the point: a pull
request without them makes the reviewer reconstruct the evidence from scratch.
-->

Closes #

## What changed

<!-- The behaviour, in a sentence or two. The diff already lists the files. -->

## Why

<!-- What was wrong or missing. Link the issue's reasoning rather than restating it. -->

## Verification

<!--
Exactly what you ran and what it said. These three are the floor for every change,
including a documentation-only one:
-->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`

<!--
Anything beyond the floor goes here with the command and its result: a container built
and booted, an endpoint curled, a migration applied, a screen measured in a browser, a
suite counted. Note the numbers — "152 web tests, server suite green" tells the reviewer
more than "tests pass".

The reviewer runs the three checks itself. A green tick in this section is a claim, not
evidence, so make the specifics checkable.
-->

## What I could not verify

<!--
Be strict and specific. No Docker daemon, no registry access, no Coolify, no real
Firebase project, no iOS device, a workflow that can only run for real once merged —
name it and say why.

An untested artefact described as verified is the failure this process exists to catch.
"Nothing" is a valid answer only when it is true.
-->

## Where to look hardest

<!--
Point at the risky part: the bit you are least sure of, the decision that could
reasonably have gone the other way, what breaks if it is wrong. Say so here if you
disagreed with the issue and did something else.
-->

---

<!--
The reviewer merges; the author does not. Labels, branches and the review gate are in
https://github.com/undiscoveredimposter/task-tracker/blob/main/docs/AGENTS.md
-->
