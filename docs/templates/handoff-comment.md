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
failed at setup never had one created, and a path that is not on disk sends the
human to a directory they will not find. No draft PR is opened for that Ticket
either, because there is nothing to push out of, so the PR clause goes with it.

The PR clause is dropped when no pull request could be opened. The whole
`<details>` block is dropped when there is no evidence to show. Evidence is
fenced because it is raw command output, which would otherwise be read as
Markdown.
