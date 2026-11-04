Closes #<n>

**Handed off at <stage>.** <failure>

See the hand-off comment on #<n> for the branch, worktree and evidence.

Run `<runId>` · transcripts in `ticket-<n>/<runId>/` on the `ticket-runner/state` branch

The last line names the Run, and where the hand-off kept its Stages'
transcripts: the place the hand-off comment's `Transcripts:` line names. It is
the same on every Host, because a hand-off keeps them on the remote wherever it
ran, which is where a human can still read them once the Host is gone.

The body is the hand-off's whether the hand-off opened the pull request or made
one that was already open a draft: that one's body is what an earlier pass or
Run wrote, with a verdict nothing is merging on and a last line about another
place. A draft is opened before the transcripts are kept, because the state
records it, so its body is written again once they are.

## When the failure was unexpected

````
Closes #<n>

**Handed off at <stage>.** `<command>` exited <code>

<details><summary>Evidence</summary>

```
<what the command printed>
```

</details>

See the hand-off comment on #<n> for the branch, worktree and evidence.
...
````

A failure the pipeline did not expect gives its opening line as the hand-off
comment's `Failure:` line does: the command and how it exited, on one line. What
the command printed follows in the same fenced Evidence block the comment
carries, whole. A failure the pipeline expected has its evidence in the comment
only, and the body has no such block.

## When nothing was kept

```
...
See the hand-off comment on #<n> for the branch, worktree and evidence.

Run `<runId>`
```

The transcripts clause is dropped in exactly the cases the hand-off comment's
`Transcripts:` line is: a hand-off that removes the state keeps no transcripts
either, a Run that ran no Stage of the Ticket has none, and a remote that
refused the write has none to point at. A path on the Host that ran the Run is
never named instead, since that Host may be gone by the time a human looks.
