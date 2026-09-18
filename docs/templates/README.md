# Pipeline output templates

The exact shapes the pipeline writes to GitHub and the terminal. The orchestrator embeds these; this folder is the source of truth for the shape, so change it here first. Angle-bracket fields are filled in; everything else is literal.

Humans read all of these, so each stays short: one line of status, details folded away.

`squash-commit.txt` is the exception to the folding: `git log` renders no HTML, so it is plain text and carries counts rather than per-criterion evidence. Its first line is the pull request title, and the rest is the merge body. `note-issue.md` is written the same way: its first line is the issue title.

| Template | Written when | Marker |
|---|---|---|
| `progress-comment.md` | first Stage of a Ticket; edited in place afterwards | `<!-- agent-pipeline:progress -->` |
| `handoff-comment.md` | a Ticket is handed to a human | `<!-- agent-pipeline:handoff -->` |
| `guard-comment.md` | a candidate is skipped by a guard | `<!-- agent-pipeline:guard:<reason> -->` |
| `note-comment.md` | a Stage's Note names the Ticket it belongs to | `<!-- agent-pipeline:note -->` |
| `note-issue.md` | a Stage's Note names no Ticket, so one is opened for it | none (issue body) |
| `pr-body.md` | the PR is opened | none (PR body) |
| `draft-pr-body.md` | a hand-off opens the PR as a draft, so no Verdict exists | none (PR body) |
| `squash-commit.txt` | the PR is squash-merged | none (commit message) |
| `run-summary.txt` | a Run ends (terminal) | none |
| `init-report.txt` | `agent-pipeline init` finishes (terminal) | none |

Markers are how the pipeline finds its own comment again. A marker is the first line of the comment and never changes. `note-comment.md` carries one without ever looking it up: nothing about a Note is edited or posted twice, but a human meeting it on an unrelated Ticket can tell what wrote it.

The two Note templates are the only ones that quote an agent's prose back to GitHub, so both escape a leading `- [ ]` to `- \[ \]`. A Ticket's checkboxes are its Acceptance Criteria to every part of the pipeline that reads them, and a Note is not asking for any.
