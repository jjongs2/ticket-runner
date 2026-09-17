# Pipeline output templates

The exact shapes the pipeline writes to GitHub and the terminal. The orchestrator embeds these; this folder is the source of truth for the shape, so change it here first. Angle-bracket fields are filled in; everything else is literal.

Humans read all of these, so each stays short: one line of status, details folded away.

| Template | Written when | Marker |
|---|---|---|
| `progress-comment.md` | first Stage of a Ticket; edited in place afterwards | `<!-- agent-pipeline:progress -->` |
| `handoff-comment.md` | a Ticket is handed to a human | `<!-- agent-pipeline:handoff -->` |
| `guard-comment.md` | a candidate is skipped by a guard | `<!-- agent-pipeline:guard:<reason> -->` |
| `pr-body.md` | the PR is opened | none (PR body) |
| `run-summary.txt` | a Run ends (terminal) | none |

Markers are how the pipeline finds its own comment again. A marker is the first line of the comment and never changes.
