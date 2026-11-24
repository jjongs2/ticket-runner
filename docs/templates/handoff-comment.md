<!-- ticket-runner:handoff -->
**Handed off.** Failed at **<stage>**<, after the fix budget was used>.

- Failure: <one line>
- Branch `<branch>` on the remote · worktree `.worktrees/ticket-<n>` · PR #<pr> (draft)
- Transcripts: `ticket-<n>/<runId>/` on the `ticket-runner/state` branch

**The <stage> Stage said:** <the Stage's noCommitReason>

<details><summary>Evidence</summary>

```
<uncommitted paths, unmet criteria and defects of the branch with evidence, or CI log excerpt>
```

</details>

The branch is named where it is on the remote, because the Host the work was
done on may be gone by the time a human looks: a cloud Host's VM does not
outlive its session. `on the remote` is said only when the
remote has the branch: one the pipeline refused to branch over at `setup` is
usually a human's and only on this Host, and a Ticket that never committed has
pushed nothing.

The transcripts line names where the hand-off kept the command line and
transcript of each Stage this Run ran for the Ticket, with those of the fix
Stage and the pass it bought under `retry/`, and the Run's `version.txt`. Where
depends on the Target's `keepTranscripts` setting, and on its visibility where
the setting is unset, as the wiki's configuration page describes:

- kept on the remote, they sit on the state branch beside the Ticket's state
  file and go when it does, so a Ticket that merges leaves none behind. The
  line is the one above.
- kept off the remote on a workstation, they stay in the Run's directory of the
  checkout, named relative to it so a public comment does not publish the
  Host's home path:

  ```
  - Transcripts: `.ticket-runner/runs/<runId>/<n>/` on the Host, kept off the remote
  ```

- kept off the remote on a cloud Host, they stay on its VM and go with it:

  ```
  - Transcripts: kept off the remote, on the cloud Host, so they go with its VM
  ```

The line is dropped when there are none to name: a hand-off that removes the
state keeps no transcripts either, a Run that ran no Stage of the Ticket has
none, and a remote that refused the write has none to point at.

The `said` paragraph quotes the reason an implement or fix Stage answered in
`noCommitReason` when it finished and the hand-off is for its committing
nothing: an implement Stage that left no commits beyond the base branch, or a
fix Stage whose branch did not grow. It sits outside the Evidence block so a
human reads it without unfolding anything, and the failure line and the
evidence stay as they would be without it. It is dropped when the Stage gave
no reason, did not finish, or committed, and every other hand-off, a later one
of the same Ticket included, has none. It is the Stage's prose posted on the
Ticket, whose comments are read for Acceptance Criteria, so a `- [ ]` at the
head of any of its lines is escaped to `- \[ \]`, as a Note's is. The draft
pull request body does not carry it; it points at this comment.

The worktree is named relative to the Target's checkout, on every Target
whatever its visibility, so a public comment does not publish the Host's home
path; so are the worktrees in a refusal's failure line and in the commands it
gives, which work from the root of the checkout. The worktree clause is dropped
when there is no worktree to name: a Ticket that
failed before its worktree was created never had one, and a path that is not on
disk sends the human to a directory they will not find. No draft pull request is
opened for such a Ticket either, because there is nothing to push out of, so
the pull request clause goes with it.

A hand-off at `setup` for a branch the pipeline refused to branch over opens no
draft pull request even when it does name a worktree: no Stage of that Run ran there, so
the branch carries a human's work, which is neither pushed to the remote unasked
nor presented as this Run's under `Closes #<n>`.

A hand-off at `setup` for a resumed Ticket whose copy of the branch on this Host
has parted from the one on the remote opens no draft pull request either, and pushes
nothing: the remote may hold another Host's newer work, and pushing this Host's
over it is the choice the human is handed. The failure says the two have
parted, names both, and says how to keep either side.

A failure the pipeline did not expect — a git or GitHub command that failed —
reaches the hand-off as an error message whose first line is the command and
how it exited, such as `` `git pull --ff-only origin main` exited 1 ``, and the
rest everything the command printed. The `Failure:` line gives the first line
only, and the output goes in the Evidence block, whole: no line of it is picked
as the reason, since a rule that picks one would name the wrong cause on an
output nobody has seen yet.

A verdict's evidence gives each unmet criterion as `- <number>. <criterion> —
<evidence>`, the criterion as its checkbox line on the Ticket reads after the
box, never as the verify Stage wrote it, and each defect of the branch as
`- Defect: <summary> — <evidence>`.

The pull request clause is dropped when no pull request could be opened. The whole
`<details>` block is dropped when there is no evidence to show. Evidence is
fenced because it is raw command output, which would otherwise be read as
Markdown.

A Ticket whose CI ran no check, its `ci` row `⚠️ no checks` or `⚠️ no workflow
runs`, and that has no met criterion beside those the verify Stage left to CI,
is handed off at `ci`: no criterion has evidence to merge on. Its evidence gives
every criterion as an unmet one is given, those left to CI as unverifiable, each one's evidence ending ` (left to CI, which ran no check on the pull request)`. The `Unverifiable criteria` below carry the same ending.

## When the Target merges by hand

```
<!-- ticket-runner:handoff -->
**Handed off.** PR #<pr> passed every gate and waits for a human to merge it: this Target merges by hand.

- Branch `<branch>` on the remote · worktree `.worktrees/ticket-<n>` · PR #<pr>

**Unverifiable criteria:**

- <criterion> — <evidence>
```

A Target whose config sets `merge` to `false` has its green Tickets handed off
at `merge` instead of merged. Nothing failed, so there is no `Failure:` line, no
`said` paragraph and no Evidence block, and no transcripts are kept. The pull
request is the one the `pr` step published, ready for review and not a draft,
its title and body unchanged, since that body is what the human reads and what
GitHub's default squash commit becomes.

The unverifiable criteria, with those the verify Stage left to CI when no CI ran
on the pull request, are what the pipeline's own squash commit would have
carried, one line each, the criterion as its checkbox line on the Ticket reads
after the box and its evidence joined into one line. A human merging by hand
gets GitHub's default message instead, so they are said here.

The comment is posted only when at least one criterion was unverifiable. Those
criteria are the one thing it carries that nothing else on the Ticket does.
When every criterion was met, the `ready-for-human` label says a human has
something to do, the progress comment's `merge` row reads `👤 left to a human`,
the pull request that closes the Ticket is linked from it, and the worktree is
where the conventions put it. The Run acts as the Target owner's account, which
GitHub does not notify of its own comment, and once the human merges, a comment
saying the pull request waits would be the closed issue's last word. Such a
Ticket, taken back later, carries on in its progress comment, as
`progress-comment.md` says.

## Once the Ticket has been taken again

```
<!-- ticket-runner:handoff -->
_Taken again by a later Run; this hand-off is history._

**Handed off.** Failed at **<stage>**.
...
```

A hand-off holds while a human holds the Ticket, and stops being current the
moment the pipeline claims the Ticket again. So the claim rewrites every
hand-off comment on the Ticket in place, adding that one line under the marker
and changing nothing else: the failure, the location and the evidence are
history worth reading, not noise to remove. An edit notifies nobody, which is
what makes it cheap enough to do on the way past.

The line is added once. A comment that already carries it is left alone, so a
Ticket claimed a third time does not stack the line, and a hand-off this Run
posts afterwards is a new comment below — the only one on the Ticket that then
reads as current.
