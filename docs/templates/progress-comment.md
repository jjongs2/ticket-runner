<!-- agent-pipeline:progress -->
**agent-pipeline** · run `<runId>` · `<branch>`

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
fix budget, `⚠️` was tolerated by a gate that is switched off.

| Stage | Outcome |
|---|---|
| implement | `✅ committed`, `❌ no commits`, `❌ <why the Stage did not finish>` |
| fix | `✅ committed`, `❌ <why the Stage did not finish>` |
| checks | `✅ passed`, ``❌ `<command>` failed`` |
| verify | `✅ <k> met · <u> unverifiable`, `❌ <k> unmet`, `❌ no evidence`, `❌ no Verdict`, `❌ <why the Stage did not finish>` |
| conflict | `✅ rebased`, `❌ unresolved`, `❌ unknown` |
| ci | `✅ passed`, `❌ failed`, `❌ no checks`, `⚠️ no checks`, `❌ timed out` |
| merge | `✅ #<pr>` |

`<why the Stage did not finish>` is the short form of a Stage failure: `rate
limited`, `timed out`, `turn capped`, `exited non-zero`, `invalid result`, or
`failed` when the Stage came back without saying which.

`conflict` is the one row that can say `❌ unknown`: the worktree decides whether
the rebase was finished, so a worktree git could not be asked about leaves the
Stage's outcome unread rather than guessed at.
