---
description: Review pull requests awaiting review, merging the ones that hold up
argument-hint: "[pull request number]"
---

Run the `pr-reviewer` subagent to review whatever is waiting, approving and merging what
holds up and pushing the rest back.

Invoke it with the Agent tool using `subagent_type: "pr-reviewer"` and
**`run_in_background: false`**. Waiting matters: this command is designed to be run on a
loop, and two reviewers running at once could both act on the same pull request — one
merging while the other is still writing pushback comments on it.

Task for the agent:

$ARGUMENTS

If no pull request number was given above, the agent reviews every open pull request whose
linked issue is labelled `status:pr_ready`, oldest first.

When it finishes, report per pull request, in a few lines each:

- the number and what it was for
- whether the checks passed **when the reviewer ran them itself**, not what the description
  claimed
- approved and merged, or pushed back — and if pushed back, the blocking reasons in one line
  each
- anything it deliberately declined to merge and left for you

A review round that approves everything and a round that rejects everything are both worth a
second look — say which happened rather than burying it.

Two things it will never do, by design: merge with a failing check, and merge a change to
the review gate itself — its own definition, CI checks, or branch protection. Those get
reviewed and left for you, because an agent that can widen its own authority to merge is not
a gate. If it hit that case, say so clearly so you know a pull request is parked and waiting
on a human.
