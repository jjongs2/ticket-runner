Closes #<n>

**Handed off at <stage>.** <failure>

See the hand-off comment on #<n> for the branch, worktree and evidence.

Run `<runId>` · transcripts in `ticket-<n>/<runId>/` on the `agent-pipeline/state` branch

The last line names the Run, and where the hand-off kept its Stages'
transcripts: the place the hand-off comment's `Transcripts:` line names. It is
the same on every Host, because a hand-off keeps them on the remote wherever it
ran, which is where a human can still read them once the Host is gone.

## When nothing was kept

```
...
See the hand-off comment on #<n> for the branch, worktree and evidence.

Run `<runId>`
```

The transcripts clause is dropped in exactly the cases the hand-off comment's
`Transcripts:` line is: a hand-off that removes the State keeps no transcripts
either, a Run that ran no Stage of the Ticket has none, and a remote that
refused the write has none to point at. A path on the Host that ran the Run is
never named instead, since that Host may be gone by the time a human looks.
