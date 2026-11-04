/**
 * The conventions document a Target must carry, and the pointer to it that
 * every agent session in that Target reads first.
 *
 * This module is the source of the text; the copy in a Target is output.
 * `ticket-runner init` writes it when it is missing and rewrites it when it says
 * something else, so a requirement changed here reaches every Target on its
 * next `init` rather than being merged into whatever the Target had.
 *
 * It states what the pipeline requires and nothing more: the type and scope
 * vocabulary, the review rules, the test policy are the Target's business, and a
 * document that took them over would be rewritten out from under it.
 *
 * The one thing it says about versions is the mark it bears: which pipeline
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

\`ticket-runner\` runs unattended sessions in this repository. What it requires of a commit, a branch, a Stage and a Ticket: \`docs/agents/pipeline-conventions.md\`. Read it before committing, opening a pull request or creating an issue.
`;

/**
 * The marker carrying the version, as the first line of the document ends.
 *
 * An HTML comment, like every other marker the pipeline finds its own writing
 * by, so it is on the line a reader sees and in none of the text they read.
 */
const MARKER = /<!-- ticket-runner:version ([^\s>]+) -->/;

/**
 * The document itself, as {@link CONVENTIONS_PATH} must contain it, marked with
 * the version writing it.
 *
 * The number alone, never the commit a development checkout adds: two checkouts
 * of one version write one document, and a Target whose copy was rewritten by
 * every commit would say nothing by having been.
 *
 * A copy with no number to stamp carries no marker rather than a marker saying
 * so. A mark nothing can read is a mark that is not there, and writing one
 * would leave `init` rewriting the same document every time it ran.
 */
export function conventionsDoc(version: string): string {
  const number = versionNumber(version);
  const marker = number === undefined ? "" : ` <!-- ticket-runner:version ${number} -->`;
  return `# ticket-runner conventions${marker}\n${BODY}`;
}

/**
 * The version number a Target's copy was written by, and undefined for a copy
 * carrying no mark at all — every copy an older pipeline wrote, which is read
 * as being behind rather than as being wrong.
 */
export function conventionsMark(document: string | undefined): string | undefined {
  const [first = ""] = (document ?? "").split("\n");
  const marked = MARKER.exec(first)?.[1];
  return marked === undefined ? undefined : versionNumber(marked);
}

/** Everything under the marked first line, which no version changes. */
const BODY = `
What \`ticket-runner\` requires of this repository, and nothing else. \`ticket-runner init\` writes this file and rewrites it whenever those requirements change, so an edit made here does not survive the next \`init\`. Everything the pipeline leaves to this repository — which commit types and scopes it uses, how it reviews, what it tests — belongs in the repository's own contributing guide.

Besides names such as GitHub and Claude Code, a capitalised word below is one of the pipeline's own terms, said in a few words where it first appears; every other word means what it ordinarily does. To the pipeline this repository is a Target, the repository a Run takes its work from and merges into. A Run is one invocation of the pipeline on a Host, the machine it executes on, and works through Tickets, GitHub issues each sized for one session of work, until it has none left to take or is told to take no more. Each Ticket is worked by Stages, each one Claude Code session with a single purpose: implement, verify, fix, or resolve a rebase conflict. A Stage may answer Notes beside its work: defects it met that belong to another Ticket or to none yet, recorded where a human will find them instead of being fixed there.

## Commits

- Subject: \`<type>(<scope>): <summary>\`.
- The type and scope vocabulary is this repository's own. The pipeline reads the shape, never the words.
- A commit subject describes its own commit. The whole branch is summarised by the \`title\` the implement and fix Stages each answer beside their Notes: one line in the same shape. The latest one becomes the pull request title, and the pull request title becomes the subject of the squash commit that lands.

## Branches

- \`agent/<n>-<slug>\` belongs to the pipeline. A Run creates one per Ticket, works in a worktree of it, and pushes it after every Stage that commits. The repository deletes it when the pull request merges, a setting \`ticket-runner init\` switches on. Nothing else branches there.
- \`ticket-runner/lock\` and \`ticket-runner/state\` belong to the pipeline too. The first says which Run holds this repository, and the second keeps the state file of every Ticket a Run can resume, and the transcripts of the Stages of a handed-off Ticket. A Hand-off gives a Ticket to a human rather than merging it, and leaves its work where they can carry on from it. Nothing else commits to either, except a human, or an Operator a human asked, the Claude session a human opens on a cloud Host from the Claude app to start a Run, watch it and stop it, releasing a lock a vanished Host left behind.
- A Stage commits only to the branch already checked out in the worktree it was started in. It creates no branch and switches to none.

## What a Stage does not do

- A Stage opens no pull request and closes no issue. The pipeline opens the pull request when the Stage finishes, waits for CI, merges it, and lets the merge close the Ticket.

## What a Ticket needs

A Ticket is one issue the pipeline can implement in a single session. It is refused unless it carries all three:

- **Acceptance Criteria** — unticked task list items, a \`- [ ]\` at the head of a line, in the issue body or in one of its comments. They are the only thing the verify Stage grades, so a promise written as prose is not one.
- **Blockers as native dependencies** — GitHub's own \`blocked by\` edges, as \`gh issue create --blocked-by <n>\` records them. A \`Blocked by\` section in the body is a human-readable copy and nothing the pipeline reads.
- **The \`ready-for-agent\` label** — how a Run finds the Ticket. A Run labels it \`in-progress\` for as long as it holds it.

## Checks

- A Check is a command the pipeline runs itself on a Ticket's code to gate it, such as its tests or its typecheck, and never the CI on a pull request, which the pipeline only waits for. The Checks of different Tickets may run at the same time, each in its own worktree, because a Run has as many Lanes as \`lanes\` says, and each Lane holds one Ticket in progress. A Target whose Checks need a port, a database or anything else they would have to share keeps \`lanes\` at one, or makes them independent of each other.
- A Check that fails on a Ticket's branch, or CI that fails on its pull request, is graded again at what the branch inherited: the pipeline runs the Check commands in a clean worktree at the branch's merge-base with the base branch. One that fails there too is the base branch's, not the Ticket's, so the Ticket is released, given back to the pipeline for a later Run to take up again, as something outside the Ticket stopped its work. That Release spends none of its fix budget (the fix Stages it is allowed), the Run claims no more Tickets, and the pipeline posts a Note on the standing Notes issue naming the Check. The next Run rebases the Ticket onto the base branch before its Checks, so mending the base branch is what frees it. Nothing is installed in the worktree at the merge-base: its Checks find their dependencies in the main checkout, as a Ticket's worktree does, so Checks that need an install or a build step of their own fail there and release the Ticket, and the Note's output shows it.

## The Operator's skill

- \`.claude/skills/ticket-runner/\` belongs to the pipeline. It tells an Operator how to start a Run, report on it and pass on a Stop, a human's request that the Run finish the Tickets its Lanes hold and take no more. \`ticket-runner init\` writes it and rewrites it like this file, so an edit made there does not survive the next \`init\` either.

## Local directories

Both are \`ticket-runner\`'s own, both are gitignored by \`ticket-runner init\`, and neither is ever committed.

- \`.worktrees/ticket-<n>/\` — one git worktree per claimed Ticket, where its Stages run. Beside them, \`.worktrees/base-<commit>/\` is a clean worktree at a merge-base with the base branch, made to run a failing Check there once and removed when it has run.
- \`.ticket-runner/\` — the Run's logs and Stage transcripts. The Run lock and the state file a Ticket keeps while its branch has work worth resuming are not here but on the Target's remote, so that a Run on any Host sees which Run holds the Target, and carries on from where a killed Run, or a handed-off Ticket relabelled \`ready-for-agent\`, stopped.
`;
