<!-- agent-pipeline:handoff -->
**Handed off.** Failed at **<stage>**<, after the fix budget was used>.

- Failure: <one line>
- Branch `<branch>` · worktree `<path>` · PR #<pr> (draft)

<details><summary>Evidence</summary>

```
<failing Check output, unmet criteria with evidence, or CI log excerpt>
```

</details>

The worktree clause is dropped when there is no worktree to name: a Ticket that
failed before its worktree was created never had one, and a path that is not on
disk sends the human to a directory they will not find. No draft PR is opened
for such a Ticket either, because there is nothing to push out of, so the PR
clause goes with it.

A hand-off at `setup` for a branch the pipeline refused to branch over opens no
draft PR even when it does name a worktree: no Stage of that Run ran there, so
the branch carries a human's work, which is neither pushed to the remote unasked
nor presented as this Run's under `Closes #<n>`.

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
