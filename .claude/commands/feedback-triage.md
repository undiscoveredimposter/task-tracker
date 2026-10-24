---
description: Evaluate the next piece of in-app feedback and route it
argument-hint: "[issue number]"
---

Run the `feedback-triage` subagent to evaluate one piece of in-app feedback and decide what
happens to it.

Invoke it with the Agent tool using `subagent_type: "feedback-triage"` and
**`run_in_background: false`**, so a loop never has two triagers working the same issue.

Task for the agent:

$ARGUMENTS

If no issue number was given above, the agent takes the oldest open issue labelled
`feedback` + `status:triage`.

When it finishes, report in a few lines:

- which issue it took, or that there was nothing to triage
- the decision (build, investigate, flag for the owner, close) and the fit and size verdicts
- the work item it created, if any

Nothing to triage is a perfectly good outcome — say so plainly and stop. Do not write code
and do not merge anything.
