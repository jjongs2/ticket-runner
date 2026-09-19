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
 */

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

/** The document itself, as {@link CONVENTIONS_PATH} must contain it. */
export const CONVENTIONS_DOC = `# agent-pipeline conventions

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

- The Checks of different Tickets run at the same time when a Run has more than one Lane, each in its own worktree. A Target whose Checks need a port, a database or anything else they would have to share keeps \`lanes\` at one, or makes them independent of each other.

## Local directories

Both are \`agent-pipeline\`'s own, both are gitignored by \`agent-pipeline init\`, and neither is ever committed.

- \`.worktrees/ticket-<n>/\` — one git worktree per claimed Ticket, where its Stages run.
- \`.agent-pipeline/\` — the Run lock, the Run's logs and Stage transcripts, and the State file a claimed Ticket keeps so that a Run killed mid-Ticket can be resumed.
`;
