<!-- agent-pipeline:handoff -->
**Handed off.** Failed at **<stage>**<, after the fix budget was used>.

- Failure: <one line>
- Branch `<branch>` on the remote · worktree `<path>` · PR #<pr> (draft)
- Transcripts: `ticket-<n>/<runId>/` on the `agent-pipeline/state` branch

<details><summary>Evidence</summary>

```
<failing Check output, unmet criteria with evidence, or CI log excerpt>
```

</details>

The branch and the transcripts are named where they are on the remote, because
the Host the work was done on may be gone by the time a human looks: a cloud
Host's VM does not outlive its session. `on the remote` is dropped when the
remote does not have the branch, as for a branch the pipeline refused to branch
over, which is only ever this Host's.

The transcripts line names where the hand-off kept the command line and
transcript of each Stage this Run ran for the Ticket, with those of the fix
Stage and the pass it bought under `retry/`, and the Run's `version.txt`. They
sit on the state branch beside the Ticket's State file and go when it does, so
a Ticket that merges leaves none behind. The line is dropped when nothing was
kept: a hand-off that removes the State keeps no transcripts either, a Run that
ran no Stage of the Ticket has none, and a remote that refused the write has
none to point at.

The worktree clause is dropped when there is no worktree to name: a Ticket that
failed before its worktree was created never had one, and a path that is not on
disk sends the human to a directory they will not find. No draft PR is opened
for such a Ticket either, because there is nothing to push out of, so the PR
clause goes with it.

A hand-off at `setup` for a branch the pipeline refused to branch over opens no
draft PR even when it does name a worktree: no Stage of that Run ran there, so
the branch carries a human's work, which is neither pushed to the remote unasked
nor presented as this Run's under `Closes #<n>`.

A hand-off at `setup` for a resumed Ticket whose copy of the branch on this Host
has parted from the one on the remote opens no draft PR either, and pushes
nothing: the remote may hold another Host's newer work, and pushing this Host's
over it is the choice the human is handed. The failure says the two have
parted, names both, and says how to keep either side.

The PR clause is dropped when no pull request could be opened. The whole
`<details>` block is dropped when there is no evidence to show. Evidence is
fenced because it is raw command output, which would otherwise be read as
Markdown. A Check the wall-clock limit killed is the one evidence the pipeline
adds a line of its own to, inside the fence: the output stops mid-run, so
something has to say that a kill is why.

## Once the Ticket has been taken again

```
<!-- agent-pipeline:handoff -->
_Taken again by a later Run; this hand-off is history._

**Handed off.** Failed at **<stage>**.
...
```

A hand-off holds while a human holds the Ticket, and stops being current the
moment the pipeline claims the Ticket again. So the Claim rewrites every
hand-off comment on the Ticket in place, adding that one line under the marker
and changing nothing else: the failure, the location and the evidence are
history worth reading, not noise to remove. An edit notifies nobody, which is
what makes it cheap enough to do on the way past.

The line is added once. A comment that already carries it is left alone, so a
Ticket claimed a third time does not stack the line, and a hand-off this Run
posts afterwards is a new comment below — the only one on the Ticket that then
reads as current.
