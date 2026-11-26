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
 * the comment that human read exactly as they read it. Everything a human has
 * to act on — a hand-off, a guard warning — stays a comment of its own, because
 * those are exactly the ones a notification is worth.
 *
 * Except one Hand-off, which posts no comment: a green Ticket on a Target that
 * merges by hand whose every criterion was met. Its label, its `merge` row
 * here and the pull request linked from the Ticket already say what a human
 * has to do, and the account the Run acts as, the Target's owner, is never
 * notified of its own comment anyway. With no hand-off comment to tell it a
 * human held the Ticket, the Run taking such a Ticket back carries on in this
 * comment like any other, below the section that human read, which it leaves
 * as it was (ADR-0004).
 *
 * `docs/templates/progress-comment.md` is the source of truth for the shape.
 */

import { carriesCurrentHandoff } from "./handoff.js";
import type { StageContext } from "./ports/agent-runner.js";
import type { IssueComment, Tracker } from "./ports/tracker.js";
import { findMarkedComment } from "./templates.js";

/** How the pipeline finds its own progress comment again. */
export const PROGRESS_MARKER = "<!-- ticket-runner:progress -->";

/**
 * What a row is about. Named after the lifecycle step rather than the Stage, for
 * the reason `FailurePoint` in `lifecycle.ts` is: CI and the merge each earn a
 * row, and neither is an agent session. `setup` earns one where a resumed
 * Ticket's worktree holds work no commit carries, and `setup`, `rebase` and
 * `pr` one where GitHub or the remote failing on its own side released the
 * Ticket there. `pr` is also the pr Stage's row, as `conflict` is the conflict
 * Stage's: each names what it worked on, and its cell what happened, so a
 * `⏸ GitHub failure` while publishing reads apart from `✅ revised`.
 */
export type ProgressPoint =
  | "setup"
  | "implement"
  | "verify"
  | "fix"
  | "conflict"
  | "rebase"
  | "pr"
  | "ci"
  | "merge";

export interface ProgressRow {
  /** Written under the `Stage` column, which is what the template heads it. */
  point: ProgressPoint;
  /** An icon and a handful of words; details belong to the hand-off comment. */
  outcome: string;
  /**
   * The main session's context when the Stage ended. A row no session reported
   * has none: CI and the merge run no agent, and neither do setup or the rebase.
   */
  context?: StageContext;
  durationMs?: number;
}

/** A cell with no answer, which is not the same as a zero. */
const NO_ANSWER = "–";

export interface ProgressCommentBody {
  /** The version reporting, as every line one Run stamps carries it. */
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
const SECTION_HEADER = "**ticket-runner**";

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
    "| Stage | Outcome | Context | Duration |",
    "|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.point} | ${cell(row.outcome)} | ${contextCell(row.context)} | ${duration(row.durationMs)} |`,
    ),
    "",
  ].join("\n");
}

/**
 * The sections of a progress comment that belong to Runs other than `runId`.
 *
 * Every section under the marker, minus the last when it is this Run's own: a
 * Run that reads the Ticket again rewrites its section rather than starting a
 * second. A comment an earlier version wrote, with one header and one table, is
 * one section like any other.
 */
function earlierSections(body: string, runId: string): string {
  const sections: string[][] = [];
  for (const line of body.trimStart().slice(PROGRESS_MARKER.length).split("\n")) {
    if (line.startsWith(SECTION_HEADER)) sections.push([line]);
    else sections.at(-1)?.push(line);
  }
  if (sections.at(-1)?.[0]?.includes(runLabel(runId))) sections.pop();
  return sections.map(headerAndTable).join("\n\n");
}

/**
 * A section's header and table as the pipeline wrote them, and nothing after.
 *
 * A Host may append a footer to every comment written — a cloud Host appends a
 * "Generated by Claude Code" line — and it lands below the last table. Carried
 * forward with that table, it would be one more footer for every Run, so
 * whatever follows the table goes, whatever its wording.
 */
function headerAndTable([header = "", ...rest]: string[]): string {
  const table = rest.findIndex((line) => line.startsWith("|"));
  if (table === -1) return header;
  const after = rest.findIndex((line, index) => index > table && !line.startsWith("|"));
  return [header, ...rest.slice(0, after === -1 ? rest.length : after)].join("\n");
}

/** A Check command or a failure summary may hold the one character a table cannot. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/** A Stage's context, followed by ` · compacted` when its main session compacted. */
function contextCell(stageContext: StageContext | undefined): string {
  if (stageContext === undefined) return NO_ANSWER;
  const figure = tokenCount(stageContext.tokens);
  return stageContext.compacted ? `${figure} · compacted` : figure;
}

/**
 * A token count as the Claude Code app's Context card writes one: `850`,
 * `107.6K`, `1M`. From a thousand it is in thousands or, from a million, in
 * millions, rounded half up to one decimal with a trailing `.0` dropped. A
 * count that rounds to a thousand thousands is a million.
 */
export function tokenCount(count: number): string {
  const whole = Math.max(0, Math.round(count));
  if (whole < 1000) return String(whole);
  const thousands = tenths(whole, 1000);
  if (whole < 1_000_000 && thousands < 10_000) return `${decimal(thousands)}K`;
  return `${decimal(tenths(whole, 1_000_000))}M`;
}

/** `count` in tenths of `unit`, rounded half up, in whole numbers so no float rounds it. */
function tenths(count: number, unit: number): number {
  return Math.floor((count * 10 + unit / 2) / unit);
}

/** A count of tenths with its one decimal, or none where it is `.0`. */
function decimal(tenthsCount: number): string {
  const rest = tenthsCount % 10;
  const units = (tenthsCount - rest) / 10;
  return rest === 0 ? String(units) : `${units}.${rest}`;
}

/**
 * A duration as GitHub Actions writes one on a pull request's checks: `40s`,
 * `1m 5s`, `3h 15m 35s`. The template says why. A clock stepped back mid-Stage
 * reads `0s` rather than a negative.
 */
function duration(durationMs: number | undefined): string {
  if (durationMs === undefined) return NO_ANSWER;
  const total = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
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
  /** Set while the comment on the Ticket lacks a row the last write failed to carry. */
  private behind = false;

  constructor(private options: ProgressOptions) {
    // A Ticket taken back from a human keeps the comment that human read: a
    // Run resuming one rewrites nothing and starts a comment of its own. Every
    // other Run — a released Ticket, a stranded one, a second pass of this one
    // — carries on in the comment it finds, which is what the one comment is
    // for, below whatever earlier Runs wrote in it. So does one taking back a
    // Ticket handed off with no hand-off comment, which only a current one
    // tells apart: nothing failed there, and the section the human read stays
    // as it was above this Run's.
    this.comment = carriesCurrentHandoff(options.comments)
      ? undefined
      : findProgressComment(options.comments);
    this.earlier =
      this.comment === undefined ? "" : earlierSections(this.comment.body, options.runId);
  }

  /**
   * Name the branch the implement Stage named, before the row that reports it:
   * every write from here on names the branch the work is on.
   */
  followBranch(branch: string): void {
    this.options = { ...this.options, branch };
  }

  /** Append a row, and show it on the Ticket. */
  async record(row: ProgressRow): Promise<void> {
    this.rows.push(row);
    await this.write();
  }

  /**
   * Write the comment once more if its last write failed, so a row GitHub
   * refused mid-Ticket is on the Ticket by the time it ends. Called once the
   * Ticket merges, is handed off or is released: no later write of the Run
   * would carry it otherwise.
   */
  async settle(): Promise<void> {
    if (this.behind) await this.write();
  }

  private async write(): Promise<void> {
    if (this.stopped) return;

    const { tracker, ticket, version, runId, branch } = this.options;
    const body = progressComment({
      version,
      runId,
      branch,
      rows: this.rows,
      earlier: this.earlier,
    });

    try {
      const id = this.comment?.id;
      if (id !== undefined) {
        await tracker.updateComment(id, body);
        this.behind = false;
        return;
      }
      this.comment = await tracker.comment(ticket, body);
      this.behind = false;
      if (this.comment.id === undefined) {
        // A comment nothing can edit is a comment per Stage, which is the noise
        // this whole table exists to avoid. One row is better than a dozen.
        this.stopped = true;
        this.options.log?.(`#${ticket} posted a progress comment it cannot edit again`);
      }
    } catch (error) {
      this.behind = true;
      this.options.log?.(
        `#${ticket} could not write the progress comment: ${(error as Error).message}`,
      );
    }
  }
}
