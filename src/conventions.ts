/**
 * The conventions document a Target must carry, and the pointer to it that
 * every agent session in that Target reads first.
 *
 * This module is the source of the text; the copy in a Target is output.
 * `agent-pipeline init` writes it when it is missing and rewrites it when it says
 * something else, so a requirement changed here reaches every Target on its
 * next `init` rather than being merged into whatever the Target had.
 *
 * It states what the pipeline requires and nothing more: the type and scope
 * vocabulary, the review rules, the test policy are the Target's business, and a
 * document that took them over would be rewritten out from under it.
 *
 * The one thing it says about Versions is the mark it bears: which pipeline
 * wrote the copy a Target carries, hidden on the first line so no reader of the
 * document meets it. That is a direction comparing text never gives — `init`
 * leaves a document a newer pipeline wrote alone, and a Run behind one warns
 * and names the upgrade rather than rewriting anything (ADR-0007).
 */

import { versionNumber } from "./version-number.js";

/** Where the document goes in a Target, relative to the Target's root. */
export const CONVENTIONS_PATH = "docs/agents/pipeline-conventions.md";

/**
 * The section `init` adds to the Target's `CLAUDE.md`.
 *
 * Added only when the file names {@link CONVENTIONS_PATH} nowhere: a human who
 * reworded the section still owns a pointer, and a second one would only be
 * noise. Appended as a top-level section, so it reads the same in a `CLAUDE.md`
 * this wrote and in one that already had a shape of its own.
 */
export const CLAUDE_SECTION = `## Pipeline conventions

\`agent-pipeline\` runs unattended sessions in this repository. What it requires of a commit, a branch, a Stage and a Ticket: \`docs/agents/pipeline-conventions.md\`. Read it before committing, opening a pull request or creating an issue.
`;

/**
 * The marker carrying the Version, as the first line of the document ends.
 *
 * An HTML comment, like every other marker the pipeline finds its own writing
 * by, so it is on the line a reader sees and in none of the text they read.
 */
const MARKER = /<!-- agent-pipeline:version ([^\s>]+) -->/;

/**
 * The document itself, as {@link CONVENTIONS_PATH} must contain it, marked with
 * the Version writing it.
 *
 * The number alone, never the commit a development checkout adds: two checkouts
 * of one Version write one document, and a Target whose copy was rewritten by
 * every commit would say nothing by having been.
 *
 * A copy with no number to stamp carries no marker rather than a marker saying
 * so. A mark nothing can read is a mark that is not there, and writing one
 * would leave `init` rewriting the same document every time it ran.
 */
export function conventionsDoc(version: string): string {
  const number = versionNumber(version);
  const marker = number === undefined ? "" : ` <!-- agent-pipeline:version ${number} -->`;
  return `# agent-pipeline conventions${marker}\n${BODY}`;
}

/**
 * The Version number a Target's copy was written by, and undefined for a copy
 * carrying no mark at all — every copy an older pipeline wrote, which is read
 * as being behind rather than as being wrong.
 */
export function conventionsMark(document: string | undefined): string | undefined {
  const [first = ""] = (document ?? "").split("\n");
  const marked = MARKER.exec(first)?.[1];
  return marked === undefined ? undefined : versionNumber(marked);
}

/** Everything under the marked first line, which no Version changes. */
const BODY = `
What \`agent-pipeline\` requires of this repository, and nothing else. \`agent-pipeline init\` writes this file and rewrites it whenever those requirements change, so an edit made here does not survive the next \`init\`. Everything the pipeline leaves to this repository — which commit types and scopes it uses, how it reviews, what it tests — belongs in the repository's own contributing guide.

## Commits

- Subject: \`<type>(<scope>): <summary> (#<n>)\`, where \`<n>\` is the Ticket number. Every commit carries the number, so no commit has to be traced back to the work it was part of.
- The type and scope vocabulary is this repository's own. The pipeline reads the shape and the number, never the words.
- The first commit of a branch is read twice: its subject becomes the pull request title, and the pull request title becomes the subject of the squash commit that lands. Write it to summarise the whole Ticket rather than the first thing that was done.

## Branches

- \`agent/<n>-<slug>\` belongs to the pipeline. A Run creates one per Ticket, works in a worktree of it, and deletes it when the pull request merges. Nothing else branches there.
- A Stage commits only to the branch already checked out in the worktree it was started in. It creates no branch and switches to none.

## What a Stage does not do

- A Stage opens no pull request and closes no issue. The pipeline opens the pull request when the Stage finishes, waits for CI, merges it, and lets the merge close the Ticket.

## What a Ticket needs

A Ticket is one issue the pipeline can implement in a single session. It is refused unless it carries all three:

- **Acceptance Criteria** — unticked task list items, a \`- [ ]\` at the head of a line, in the issue body or in one of its comments. They are the only thing the verify Stage grades, so a promise written as prose is not one.
- **Blockers as native dependencies** — GitHub's own \`blocked by\` edges, as \`gh issue create --blocked-by <n>\` records them. A \`Blocked by\` section in the body is a human-readable copy and nothing the pipeline reads.
- **The \`ready-for-agent\` label** — how a Run finds the Ticket. A Run labels it \`in-progress\` for as long as it holds it.

## Checks

- The Checks of different Tickets may run at the same time, each in its own worktree, because a Run has as many Lanes as \`lanes\` says. A Target whose Checks need a port, a database or anything else they would have to share keeps \`lanes\` at one, or makes them independent of each other.

## Local directories

Both are \`agent-pipeline\`'s own, both are gitignored by \`agent-pipeline init\`, and neither is ever committed.

- \`.worktrees/ticket-<n>/\` — one git worktree per claimed Ticket, where its Stages run.
- \`.agent-pipeline/\` — the Run lock, the Run's logs and Stage transcripts, and the State file a claimed Ticket keeps so that a Run killed mid-Ticket can be resumed.
`;
