/**
 * The one comment a Ticket's Stages share.
 *
 * A Run reports on a Ticket a dozen times, and a comment per report would make
 * the Ticket unreadable and notify its watchers every time. So there is one
 * comment, found by a hidden marker and rewritten in place as each Stage
 * finishes: only the first Stage notifies anyone. Each Run that works the
 * Ticket has a section of it, below the sections earlier Runs left exactly as
 * they left them, because a cloud Host's transcripts go with its VM and those
 * sections are then all that says what that Run did. The one Run that starts a
 * second comment is the one taking the Ticket back from a human, which leaves
 * the comment that human read exactly as they read it. Everything a human has to act on — a
 * hand-off, a guard warning — stays a comment of its own, because those are
 * exactly the ones a notification is worth.
 *
 * `docs/templates/progress-comment.md` is the source of truth for the shape.
 */

import { carriesCurrentHandoff } from "./handoff.js";
import type { IssueComment, Tracker } from "./ports/tracker.js";
import { findMarkedComment } from "./templates.js";

/** How the pipeline finds its own progress comment again. */
export const PROGRESS_MARKER = "<!-- agent-pipeline:progress -->";

/**
 * What a row is about. Named after the lifecycle step rather than the Stage, for
 * the reason `FailurePoint` in `lifecycle.ts` is: the Checks, CI and the merge
 * each earn a row, and none of them is an agent session.
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
  /** The Version reporting, as every line one Run stamps carries it. */
  version: string;
  runId: string;
  branch: string;
  /** Every row so far, oldest first. */
  rows: ProgressRow[];
  /**
   * The sections earlier Runs wrote, oldest first, exactly as they wrote them.
   * This Run's section goes below them.
   */
  earlier?: string;
}

/** Opens every section, and is how one is told from the table above it. */
const SECTION_HEADER = "**agent-pipeline**";

/** How a section's header names its Run, which is how a Run finds its own. */
function runLabel(runId: string): string {
  return `run \`${runId}\``;
}

export function progressComment({
  version,
  runId,
  branch,
  rows,
  earlier = "",
}: ProgressCommentBody): string {
  return [
    PROGRESS_MARKER,
    ...(earlier === "" ? [] : [earlier, ""]),
    `${SECTION_HEADER} \`${version}\` · ${runLabel(runId)} · \`${branch}\``,
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

/**
 * The sections of a progress comment that belong to Runs other than `runId`.
 *
 * Everything under the marker, minus the last section when it is this Run's
 * own: a Run that reads the Ticket again rewrites its section rather than
 * starting a second. A comment an earlier Version wrote, with one header and one
 * table, is one section like any other. Only the blank lines around the sections
 * are the template's; what is between them comes back as it was.
 */
function earlierSections(body: string, runId: string): string {
  const sections = body.trimStart().slice(PROGRESS_MARKER.length).trim();
  const lines = sections.split("\n");
  const last = lines.findLastIndex((line) => line.startsWith(SECTION_HEADER));
  return lines[last]?.includes(runLabel(runId))
    ? lines.slice(0, last).join("\n").trimEnd()
    : sections;
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
  version: string;
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
  /** What earlier Runs wrote in the comment this Run carries on in. */
  private readonly earlier: string;
  /** Set when reporting again could only mean a second comment, never an edit. */
  private stopped = false;

  constructor(private readonly options: ProgressOptions) {
    // A Ticket taken back from a human keeps the comment that human read: a
    // Run resuming one rewrites nothing and starts a comment of its own. Every
    // other Run — a released Ticket, a stranded one, a second pass of this one
    // — carries on in the comment it finds, which is what the one comment is
    // for, below whatever earlier Runs wrote in it.
    this.comment = carriesCurrentHandoff(options.comments)
      ? undefined
      : findProgressComment(options.comments);
    this.earlier =
      this.comment === undefined ? "" : earlierSections(this.comment.body, options.runId);
  }

  /** Append a row, and show it on the Ticket. */
  async record(row: ProgressRow): Promise<void> {
    this.rows.push(row);
    if (this.stopped) return;

    const { tracker, ticket, version, runId, branch } = this.options;
    const { earlier } = this;
    const body = progressComment({ version, runId, branch, rows: this.rows, earlier });

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
