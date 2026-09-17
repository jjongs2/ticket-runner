/**
 * The one comment a Ticket's Stages share.
 *
 * A Run reports on a Ticket a dozen times, and a comment per report would make
 * the Ticket unreadable and notify its watchers every time. So there is one
 * comment, found by a hidden marker and rewritten in place as each Stage
 * finishes: only the first Stage notifies anyone. Everything a human has to act
 * on — a hand-off, a guard warning — stays a comment of its own, because those
 * are exactly the ones a notification is worth.
 *
 * `docs/templates/progress-comment.md` is the source of truth for the shape.
 */

import type { IssueComment, Tracker } from "./ports/tracker.js";
import { findMarkedComment } from "./templates.js";

/** How the pipeline finds its own progress comment again. */
export const PROGRESS_MARKER = "<!-- agent-pipeline:progress -->";

/**
 * What a row is about. Named after the lifecycle step rather than the Stage,
 * for the reason {@link import("./lifecycle.js").FailurePoint} is: the Checks,
 * CI and the merge each earn a row and none of them is an agent session.
 */
export type ProgressPoint =
  | "implement"
  | "checks"
  | "verify"
  | "fix"
  | "conflict"
  | "ci"
  | "merge";

export interface ProgressRow {
  /** Written under the `Stage` column, which is what the template heads it. */
  point: ProgressPoint;
  /** An icon and a handful of words; details belong to the hand-off comment. */
  outcome: string;
  /** Agent turns. Checks, CI and the merge run no agent, so they have none. */
  turns?: number;
  durationMs?: number;
}

/** A cell with no answer, which is not the same as a zero. */
const NO_ANSWER = "–";

export interface ProgressCommentBody {
  runId: string;
  branch: string;
  /** Every Stage that has finished, oldest first. */
  rows: ProgressRow[];
}

export function progressComment({ runId, branch, rows }: ProgressCommentBody): string {
  return [
    PROGRESS_MARKER,
    `**agent-pipeline** · run \`${runId}\` · \`${branch}\``,
    "",
    "| Stage | Outcome | Turns | Duration |",
    "|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.point} | ${cell(row.outcome)} | ${count(row.turns)} | ${minutes(row.durationMs)} |`,
    ),
    "",
  ].join("\n");
}

/** A Check command or a failure summary may hold the one character a table cannot. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function count(turns: number | undefined): string {
  return turns === undefined ? NO_ANSWER : String(turns);
}

/** Minutes, as the rest of the pipeline reports durations to humans. */
function minutes(durationMs: number | undefined): string {
  return durationMs === undefined ? NO_ANSWER : `${Math.round(durationMs / 60_000)}m`;
}

/**
 * The progress comment already on a Ticket, if there is one this Run can edit.
 *
 * A Run that comes back to a Ticket another Run reported on carries on in that
 * comment rather than starting a second table beside it. One the tracker gave
 * no id for is not one of those: it cannot be edited, so a fresh comment is the
 * only way to report at all.
 */
export function findProgressComment(comments: IssueComment[]): IssueComment | undefined {
  const found = findMarkedComment(comments, PROGRESS_MARKER);
  return found?.id === undefined ? undefined : found;
}

export interface ProgressOptions {
  tracker: Tracker;
  ticket: number;
  runId: string;
  branch: string;
  /** The Ticket's comments as they were when it was claimed. */
  comments: IssueComment[];
  log?: (line: string) => void;
}

/**
 * One Ticket's progress comment, from the first Stage to the merge.
 *
 * Holds the rows so far and the comment they are written to, so the orchestrator
 * only ever says what just happened. Nothing here throws: the comment is how a
 * human watches a Ticket, not part of how it is decided, and a Ticket that is
 * otherwise mergeable must not be handed off because GitHub would not take a
 * table.
 */
export class Progress {
  private readonly rows: ProgressRow[] = [];
  private comment: IssueComment | undefined;
  /** Set when reporting again could only mean a second comment, never an edit. */
  private stopped = false;

  constructor(private readonly options: ProgressOptions) {
    this.comment = findProgressComment(options.comments);
  }

  /** Append a row, and show it on the Ticket. */
  async record(row: ProgressRow): Promise<void> {
    this.rows.push(row);
    if (this.stopped) return;

    const { tracker, ticket, runId, branch } = this.options;
    const body = progressComment({ runId, branch, rows: this.rows });

    try {
      const id = this.comment?.id;
      if (id !== undefined) {
        await tracker.updateComment(id, body);
        return;
      }
      this.comment = await tracker.comment(ticket, body);
      if (this.comment.id === undefined) {
        // A comment nothing can edit is a comment per Stage, which is the noise
        // this whole table exists to avoid. One row is better than a dozen.
        this.stopped = true;
        this.options.log?.(`#${ticket} posted a progress comment it cannot edit again`);
      }
    } catch (error) {
      this.options.log?.(
        `#${ticket} could not write the progress comment: ${(error as Error).message}`,
      );
    }
  }
}
