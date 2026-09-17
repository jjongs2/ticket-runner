/**
 * The exact shapes the pipeline writes to GitHub. `docs/templates/` is the
 * source of truth for these; change it there first.
 */

import type { FailurePoint } from "./lifecycle.js";
import type { TicketOutcome } from "./orchestrator.js";
import type { SquashCommit } from "./ports/tracker.js";
import { type Criterion, type Verdict, countStatuses } from "./verdict.js";

/** How the pipeline finds its own hand-off comment again. */
export const HANDOFF_MARKER = "<!-- agent-pipeline:handoff -->";

/** The Verdict summary both the pull request body and the squash commit carry. */
function verdictCounts(verdict: Verdict): string {
  const counts = countStatuses(verdict);
  return `${counts.met} met · ${counts.unmet} unmet · ${counts.unverifiable} unverifiable`;
}

const STATUS_ICON: Record<Criterion["status"], string> = {
  met: "✅",
  unmet: "❌",
  unverifiable: "❓",
};

export interface PullRequestBody {
  ticket: number;
  verdict: Verdict;
  runId: string;
}

export function pullRequestBody({ ticket, verdict, runId }: PullRequestBody): string {
  const criteria = verdict.criteria.map((criterion) => {
    const line = `- ${STATUS_ICON[criterion.status]} ${criterion.text}`;
    return criterion.status === "met" ? line : `${line} — ${criterion.evidence}`;
  });

  return [
    `Closes #${ticket}`,
    "",
    `**Verdict:** ${verdictCounts(verdict)}`,
    "",
    "<details><summary>Criteria</summary>",
    "",
    ...criteria,
    "",
    "</details>",
    "",
    `Run \`${runId}\` · transcripts in \`.agent-pipeline/runs/${runId}/${ticket}/\``,
    "",
  ].join("\n");
}

export interface DraftPullRequestBody {
  ticket: number;
  stage: FailurePoint;
  failure: string;
  runId: string;
}

/** The body of the draft PR a hand-off leaves behind; there is no Verdict yet. */
export function draftPullRequestBody({
  ticket,
  stage,
  failure,
  runId,
}: DraftPullRequestBody): string {
  return [
    `Closes #${ticket}`,
    "",
    `**Handed off at ${stage}.** ${failure}`,
    "",
    `See the hand-off comment on #${ticket} for the branch, worktree and evidence.`,
    "",
    `Run \`${runId}\` · transcripts in \`.agent-pipeline/runs/${runId}/${ticket}/\``,
    "",
  ].join("\n");
}

export interface SquashCommitMessage {
  ticket: number;
  /** The pull request number, appended to the subject as GitHub would. */
  pullRequest: number;
  /** The pull request title, which is the subject that lands on main. */
  title: string;
  verdict: Verdict;
  /** The branch's commit subjects, oldest first. */
  commits: string[];
  /** Unique `Co-authored-by` values from the branch, carried as trailers. */
  coAuthors: string[];
}

/**
 * The commit a merged Ticket leaves on main.
 *
 * `git log` renders no HTML, so this is the one template with nothing folded
 * away: the Verdict is counts only, and the per-criterion evidence stays in the
 * pull request body where a browser can collapse it.
 */
export function squashCommit({
  ticket,
  pullRequest,
  title,
  verdict,
  commits,
  coAuthors,
}: SquashCommitMessage): SquashCommit {
  // What GitHub's default message would have carried, now carried by hand.
  const trailers = coAuthors.map((author) => `Co-authored-by: ${author}`);
  return {
    subject: `${title} (#${pullRequest})`,
    body: [
      `Closes #${ticket}`,
      "",
      `Verdict: ${verdictCounts(verdict)}`,
      "",
      ...commits.map((subject) => `- ${subject}`),
      "",
      ...(trailers.length === 0 ? [] : [...trailers, ""]),
    ].join("\n"),
  };
}

export interface HandoffComment {
  stage: FailurePoint;
  /** One line a human can read in a notification. */
  failure: string;
  branch: string;
  worktree: string;
  pullRequest?: number;
  /** Failing Check output, unmet criteria, or a CI log excerpt. */
  evidence: string;
}

export function handoffComment(handoff: HandoffComment): string {
  const location = [
    `Branch \`${handoff.branch}\``,
    `worktree \`${handoff.worktree}\``,
    ...(handoff.pullRequest === undefined ? [] : [`PR #${handoff.pullRequest} (draft)`]),
  ].join(" · ");

  const lines = [
    HANDOFF_MARKER,
    `**Handed off.** Failed at **${handoff.stage}**.`,
    "",
    `- Failure: ${handoff.failure}`,
    `- ${location}`,
    "",
  ];

  const evidence = handoff.evidence.trim();
  if (evidence !== "") {
    lines.push(
      "<details><summary>Evidence</summary>",
      "",
      "```",
      evidence,
      "```",
      "",
      "</details>",
      "",
    );
  }

  return lines.join("\n");
}

export interface RunSummary {
  runId: string;
  durationMs: number;
  outcomes: TicketOutcome[];
  /**
   * Candidates an open blocker kept off the Frontier for the whole Run. Only a
   * Run has a Frontier, so `ticket <n>` leaves this out and the summary says
   * nothing about what else was pickable.
   */
  blocked?: number[];
}

/** Every summary row is `<verb> #<n> <detail>`, so the numbers line up. */
const VERB_WIDTH = 9;

/**
 * What a Run prints when it ends. One line per Ticket, then why the Run
 * stopped — the Frontier is either empty or everything left on it is blocked.
 */
export function runSummary({ runId, durationMs, outcomes, blocked }: RunSummary): string {
  const rows = [
    ...outcomes.map(ticketRow),
    ...(blocked ?? []).map((ticket) => row("skipped", ticket, "blocked")),
  ];

  return [
    `agent-pipeline run ${runId} · ${Math.round(durationMs / 60_000)}m`,
    "",
    ...(rows.length === 0 ? ["  nothing to do"] : rows),
    "",
    ...(blocked === undefined ? [] : [blocked.length === 0 ? "Frontier empty." : "Frontier blocked."]),
    "",
  ].join("\n");
}

/** One Ticket's line in a summary: what happened to it, and where to look. */
function ticketRow(outcome: TicketOutcome): string {
  return outcome.outcome === "merged"
    ? row("merged", outcome.ticket, `${outcome.title} (PR #${outcome.pullRequest})`)
    : row(
        "handed",
        outcome.ticket,
        `${outcome.title} · ${outcome.stage} · ${outcome.failure}`,
      );
}

function row(verb: string, ticket: number, detail: string): string {
  return `  ${verb.padEnd(VERB_WIDTH)}#${ticket} ${detail}`;
}
