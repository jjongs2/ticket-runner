<!-- agent-pipeline:handoff -->
**Handed off.** Failed at **<stage>**<, after the fix budget was used>.

- Failure: <one line>
- Branch `<branch>` · worktree `<path>` · PR #<pr> (draft)

<details><summary>Evidence</summary>

```
<failing Check output, unmet criteria with evidence, or CI log excerpt>
```

</details>

The PR clause is dropped when no pull request could be opened. The whole
`<details>` block is dropped when there is no evidence to show. Evidence is
fenced because it is raw command output, which would otherwise be read as
Markdown.
