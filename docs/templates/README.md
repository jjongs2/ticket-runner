# Pipeline output templates

The exact shapes written to GitHub and the terminal: the pipeline's own, which the orchestrator embeds, the Operator's skill, which `init` copies into a Target as it is, and the one a Version PR carries. This folder is the source of truth for every shape, so change it here first. Angle-bracket fields are filled in; everything else is literal.

Humans read all of these, so each stays short: one line of status, details folded away.

`squash-commit.txt` is the exception to the folding: `git log` renders no HTML, so it is plain text and carries counts rather than per-criterion evidence. Its first line is the pull request title, and the rest is the merge body. `notes-issue.md` is written the same way: its first line is the issue title.

| Template | Written when | Marker |
|---|---|---|
| `progress-comment.md` | first Stage of a Ticket; edited in place afterwards | `<!-- agent-pipeline:progress -->` |
| `handoff-comment.md` | a Ticket is handed to a human; marked as history when the Ticket is claimed again | `<!-- agent-pipeline:handoff -->` |
| `guard-comment.md` | a candidate is skipped by a guard | `<!-- agent-pipeline:guard:<reason> -->` |
| `note-comment.md` | a Stage makes a Note, wherever it is routed | `<!-- agent-pipeline:note -->` |
| `notes-issue.md` | a Note cannot reach a Ticket and no standing Notes issue is open | `<!-- agent-pipeline:notes-issue -->` (issue body) |
| `pr-body.md` | the PR is opened | none (PR body) |
| `draft-pr-body.md` | a hand-off opens the PR as a draft, so no Verdict exists | none (PR body) |
| `squash-commit.txt` | the PR is squash-merged | none (commit message) |
| `run-summary.txt` | a Run ends (terminal) | none |
| `init-report.txt` | `agent-pipeline init` finishes (terminal) | none |
| `stop-report.txt` | `agent-pipeline stop` asks a Run to stop, or says why it did not (terminal) | none |
| `operator-skill.md` | `agent-pipeline init` writes it into the Target as `.claude/skills/agent-pipeline/SKILL.md` | none (a project skill) |
| `version-notes.md` | a Version PR is opened, by the `cut-a-version` skill | none (a `CHANGELOG.md` section) |

`version-notes.md` is the one shape nothing in the pipeline writes. A human cuts a Version, the `cut-a-version` skill drafts that Version's section of `CHANGELOG.md` in this shape, and the tag workflow publishes the section as the Release body (ADR-0007). It is kept here because the check on a Version PR reads the same shape, and a shape two readers share belongs where every other one does.

`operator-skill.md` is the one shape the pipeline reads from this folder rather than embedding: it is long prose with no field to fill, so the package carries the file itself and `init` copies it into a Target verbatim, frontmatter and all. It is what an Operator, the Claude session a human opens on a cloud Host, follows, and a cloud session carries nothing over but the repository, so it has to be in the Target (ADR-0008). It names no Version: the Operator reads the one to install off the conventions document's mark.

The conventions document `init` writes carries a marker of its own, `<!-- agent-pipeline:version <number> -->`, and is the one that is *on* a first line rather than *being* one: it ends the document's heading, so no reader of the document meets it. It also changes, because what it carries is the Version that wrote the copy — which is what lets `init` leave a Target a newer pipeline set up alone, and a Run warn about a copy from another Version without touching it (ADR-0007). It is not in this folder because no template writes it: `src/conventions.ts` is the document's only shape.

Markers are how the pipeline finds its own writing again. A marker is the first line of the comment and never changes. A Ticket can carry more than one comment under the same marker: a hand-off is a comment of its own each time, and the Claim marks every one of them as history rather than only the newest. `note-comment.md` carries one without ever looking it up: nothing about a Note is edited or posted twice, but a human meeting it on an unrelated Ticket can tell what wrote it.

`notes-issue.md` is the one marker that is not on a comment at all: it is the first line of an issue body, and the only thing that identifies the standing Notes issue. A title can be renamed and a comment can be deleted; a body the pipeline wrote and never rewrites is what survives both. Its marker is deliberately not `note-comment.md`'s — one marks the issue, the other marks the Notes on it.

`note-comment.md` is the only template that quotes an agent's prose back to GitHub, so it escapes a leading `- [ ]` to `- \[ \]`. A Ticket's checkboxes are its Acceptance Criteria to every part of the pipeline that reads them, and a Note is not asking for any.
