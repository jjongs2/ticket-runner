<!-- agent-pipeline:progress -->
**agent-pipeline** `<version>` · run `<runId>` · `<branch>`

| Stage | Outcome | Turns | Duration |
|---|---|---|---|
| implement | ✅ committed | <n> | <m>m |
| checks | ✅ passed | – | <m>m |
| verify | ⏸ rate limited | <n> | <m>m |

**agent-pipeline** `<version>` · run `<runId>` · `<branch>`

| Stage | Outcome | Turns | Duration |
|---|---|---|---|
| checks | ✅ passed | – | <m>m |
| verify | ❌ <k> unmet | <n> | <m>m |
| fix | ✅ committed | <n> | <m>m |
| checks | ✅ passed | – | <m>m |
| verify | ✅ <k> met · <u> unverifiable | <n> | <m>m |
| conflict | ✅ rebased | <n> | <m>m |
| checks | ✅ passed | – | <m>m |
| ci | ✅ passed | – | <m>m |
| merge | ✅ #<pr> | – | – |

One section per Run that worked the Ticket, oldest first: the header naming
that Run's Version, runId and branch, a blank line, and that Run's table. A
Ticket one Run took from the Claim to the merge has one section.

One row per Stage or gate, appended as it finishes, in the order it happened.
Rows are not unique: a fix buys a second pass of the Checks and verify, and each
rebase conflict adds a `conflict` row and the `checks` row that re-grades what it
resolved. A Stage that is never reached has no row, which is how the table shows
where a Ticket stopped.

`<version>` is the Version that wrote the table (ADR-0007), in the shape
`run-summary.txt` describes.

A later Run finds this comment by its marker and carries on in it: it leaves
every section already there exactly as it was and writes its own below them,
whether the Ticket was released, stranded, or resumed on the same Host or
another. A Run's transcripts go with a cloud Host's VM, so the sections an
earlier Run wrote are the only record of which Stages it ran, on which Version,
and what they cost. A Run whose own section is already the last one — the same
runId — rewrites that section rather than starting a second. A comment an
earlier Version wrote, with one header and one table, is one earlier section.

The header names no Host. The runId finds it: every commit on the
`agent-pipeline/lock` branch that takes the lock opens ``Held by run <runId> on
<Host>``.

One Run does not carry on: the one taking the Ticket back from a human, which is
a Ticket carrying a hand-off comment not yet marked as history. It posts a
comment of its own below the one the human read, leaving that one exactly as
they read it. So a Ticket can carry more than one of these, and the newest is
the one being written.

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
| checks | `✅ passed`, `❌ uncommitted work`, ``❌ `<command>` failed``, ``❌ `<command>` timed out`` |
| verify | `✅ <k> met · <u> unverifiable`, `❌ <k> unmet`, `❌ no evidence`, `❌ no Verdict`, `⏸ rate limited`, `❌ <why the Stage did not finish>` |
| conflict | `✅ rebased`, `❌ unresolved`, `⏸ rate limited`, `❌ unknown` |
| ci | `✅ passed`, `❌ failed`, `❌ conflicting`, `❌ no checks`, `⚠️ no checks`, `❌ timed out` |
| merge | `✅ #<pr>` |

A `checks` row tells a command that exited non-zero from one the wall-clock
limit killed: both are the same failure to the fix budget, but a hang is not a
failing assertion, and a fix Stage is told which it is mending.

`❌ conflicting` is the `ci` row for a pull request GitHub reports as
conflicting with the Base branch, which has moved since the rebase — a human
merging on GitHub meanwhile, say. GitHub runs no workflow for such a pull
request, so it is not `❌ no checks`, and it is not the `conflict` Stage: that
row is the rebase before the pull request, and this one comes after it.

`❌ uncommitted work` is the `checks` row no command wrote: the worktree held
changes no commit carries, so no Check ran. What lands is the branch, and a
worktree graded with work the branch lacks would pass on code the pull request
never carries.

`<why the Stage did not finish>` is the short form of a Stage failure: `timed
out`, `turn capped`, `exited non-zero`, `invalid result`, or `failed` when the
Stage came back without saying which. The subscription rate limit is the one
Stage failure that is nothing about the Ticket, so it reads `⏸ rate limited`
and is the last row of its Run's table: the Ticket is released there, and the Run
that resumes it writes its own section below this one.

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
