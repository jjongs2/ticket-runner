/**
 * The exact shapes the pipeline writes to GitHub. `docs/templates/` is the
 * source of truth for these; change it there first.
 */

import type { FailurePoint } from "./lifecycle.js";
import { type Criterion, type Verdict, countStatuses } from "./verdict.js";

/** How the pipeline finds its own hand-off comment again. */
export const HANDOFF_MARKER = "<!-- agent-pipeline:handoff -->";

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
  const counts = countStatuses(verdict);
  const criteria = verdict.criteria.map((criterion) => {
    const line = `- ${STATUS_ICON[criterion.status]} ${criterion.text}`;
    return criterion.status === "met" ? line : `${line} — ${criterion.evidence}`;
  });

  return [
    `Closes #${ticket}`,
    "",
    `**Verdict:** ${counts.met} met · ${counts.unmet} unmet · ${counts.unverifiable} unverifiable`,
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
