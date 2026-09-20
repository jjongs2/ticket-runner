<!-- agent-pipeline:progress -->
**agent-pipeline** `<version>` · run `<runId>` · `<branch>`

| Stage | Outcome | Turns | Duration |
|---|---|---|---|
| implement | ✅ committed | <n> | <m>m |
| checks | ✅ passed | – | <m>m |
| verify | ❌ <k> unmet | <n> | <m>m |
| fix | ✅ committed | <n> | <m>m |
| checks | ✅ passed | – | <m>m |
| verify | ✅ <k> met · <u> unverifiable | <n> | <m>m |
| conflict | ✅ rebased | <n> | <m>m |
| checks | ✅ passed | – | <m>m |
| ci | ✅ passed | – | <m>m |
| merge | ✅ #<pr> | – | – |

One row per Stage or gate, appended as it finishes, in the order it happened.
Rows are not unique: a fix buys a second pass of the Checks and verify, and each
rebase conflict adds a `conflict` row and the `checks` row that re-grades what it
resolved. A Stage that is never reached has no row, which is how the table shows
where a Ticket stopped.

`<version>` is the Version that wrote the table (ADR-0007), in the shape
`run-summary.txt` describes.

A later Run finds this comment by its marker and carries on in it, rewriting the
header and the rows with its own. The table is what the Run reporting now did,
not a history of every Run the Ticket has had; the transcripts under
`.agent-pipeline/runs/` are that.

`–` is what a cell has no answer for: Checks, CI and the merge run no agent, so
they have no turn count, and the merge takes no measurable time of its own.

Details never go in a cell. The failing Check's output, the unmet criteria and
their evidence belong to the hand-off comment, which is a separate comment so it
notifies; this one is edited in place and notifies nobody after the first Stage.

## Outcome cells

An icon and a handful of words. `✅` passed, `❌` ended the Ticket or spent its
fix budget, `⚠️` was tolerated by a gate that is switched off, `⏸` released the
Ticket for a later Run to resume.

| Stage | Outcome |
|---|---|
| implement | `✅ committed`, `❌ no commits`, `⏸ rate limited`, `❌ <why the Stage did not finish>` |
| fix | `✅ committed`, `❌ no commits`, `⏸ rate limited`, `❌ <why the Stage did not finish>` |
| checks | `✅ passed`, ``❌ `<command>` failed``, ``❌ `<command>` timed out`` |
| verify | `✅ <k> met · <u> unverifiable`, `❌ <k> unmet`, `❌ no evidence`, `❌ no Verdict`, `⏸ rate limited`, `❌ <why the Stage did not finish>` |
| conflict | `✅ rebased`, `❌ unresolved`, `⏸ rate limited`, `❌ unknown` |
| ci | `✅ passed`, `❌ failed`, `❌ no checks`, `⚠️ no checks`, `❌ timed out` |
| merge | `✅ #<pr>` |

A `checks` row tells a command that exited non-zero from one the wall-clock
limit killed: both are the same failure to the fix budget, but a hang is not a
failing assertion, and a fix Stage is told which it is mending.

`<why the Stage did not finish>` is the short form of a Stage failure: `timed
out`, `turn capped`, `exited non-zero`, `invalid result`, or `failed` when the
Stage came back without saying which. The subscription rate limit is the one
Stage failure that is nothing about the Ticket, so it reads `⏸ rate limited`
and is the last row of the table: the Ticket is released there, and the Run that
resumes it writes its own table over this one.

`❌ no commits` reads the same on both Stages the branch is asked about — a
session that came back having committed nothing — but it is not the same
question. implement asks whether the branch carries anything at all; fix asks
whether it grew, since implement's commits are already on it. A fix Stage that
answers no ends the Ticket where it stands, because the fix budget it would take
to try again is the one already spent on it.

A `conflict` Stage that came back rate-limited is still read as `✅ rebased`
when it had finished the rebase first: the worktree decides that row, so a
Stage that did the job and only then ran into the limit is not released.

`conflict` is the one row that can say `❌ unknown`: the worktree decides whether
the rebase was finished, so a worktree git could not be asked about leaves the
Stage's outcome unread rather than guessed at.
