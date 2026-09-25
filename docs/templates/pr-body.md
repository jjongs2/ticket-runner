Closes #<n>

**Verdict:** <k> met · <u> unmet · <v> unverifiable

<details><summary>Criteria</summary>

- ✅ <criterion>
- ❓ <criterion> — <evidence>

</details>

Run `<runId>` · transcripts in `.agent-pipeline/runs/<runId>/<n>/`

The last line names the Run, and the directory on the Host that ran it where
its Stages' transcripts are. That is the shape on a workstation, whose run
directory outlives the Run.

A Ticket that was handed off and merges later has its body rewritten at the
merge, in this shape or the cloud one below, so it never keeps the state-branch
pointer its draft body carried: the merge removes what that pointer names.

## On a cloud Host

```
...
</details>

Run `<runId>`
```

The transcripts clause is dropped on a cloud Host, and the Run is named alone.
A merged Ticket keeps no transcripts on the remote, since they go with its
State, and a cloud Host's VM does not outlive its session, so nothing is left
for the clause to point at.
