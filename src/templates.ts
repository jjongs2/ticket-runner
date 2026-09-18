/**
 * The exact shapes the pipeline writes to GitHub. `docs/templates/` is the
 * source of truth for these; change it there first.
 */

import { UNCHECKED_BOX } from "./acceptance-criteria.js";
import type { GuardReason } from "./guards.js";
import type { FailurePoint } from "./lifecycle.js";
import type { RoutedNote } from "./notes.js";
import type { TicketOutcome } from "./orchestrator.js";
import type { StageName } from "./ports/agent-runner.js";
import type { IssueComment, SquashCommit } from "./ports/tracker.js";
import type { RunStop } from "./run.js";
import { type Criterion, type Verdict, countStatuses } from "./verdict.js";

/** How the pipeline finds its own hand-off comment again. */
export const HANDOFF_MARKER = "<!-- agent-pipeline:handoff -->";

/** What a Note comment is signed with. Nothing looks it up; a human reads it. */
export const NOTE_MARKER = "<!-- agent-pipeline:note -->";

/** How the pipeline finds a warning it has already posted: one marker per reason. */
export function guardMarker(reason: GuardReason): string {
  return `<!-- agent-pipeline:guard:${reason} -->`;
}

/** What each guard tells the human: what was wrong, and what to do about it. */
const GUARD_SENTENCES: Record<GuardReason, string> = {
  spec:
    "This issue has sub-issues, so it is a Spec, not a Ticket; `ready-for-agent` " +
    "was removed. Its Tickets are picked up individually.",
  "no-criteria":
    "No `- [ ]` acceptance criteria found in the body or comments. Add criteria " +
    "the verify Stage can grade, then re-run.",
  "body-only-blockers":
    "The body lists blockers that have no native `blocked by` edge. Add the edges " +
    "with `gh issue edit <n> --add-blocked-by <m>`, then re-run.",
};

/**
 * The comment carrying `marker`, if the issue has one.
 *
 * The marker is the first line of every pipeline comment and never changes,
 * which is the whole point of it: this is how the pipeline finds what it has
 * already written rather than writing it again.
 */
export function findMarkedComment(
  comments: IssueComment[],
  marker: string,
): IssueComment | undefined {
  return comments.find((comment) => comment.body.trimStart().startsWith(marker));
}

/** Whether a candidate has already been warned about this. */
export function hasGuardWarning(comments: IssueComment[], reason: GuardReason): boolean {
  return findMarkedComment(comments, guardMarker(reason)) !== undefined;
}

/** The one warning a skipped candidate gets. Two sentences: the reason, the fix. */
export function guardComment(reason: GuardReason): string {
  return [
    guardMarker(reason),
    `**Skipped by agent-pipeline.** ${GUARD_SENTENCES[reason]}`,
    "",
  ].join("\n");
}

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
  /** The pull request title, which is the subject that lands on the base branch. */
  title: string;
  verdict: Verdict;
  /** The branch's commit subjects, oldest first. */
  commits: string[];
  /** Unique `Co-authored-by` values from the branch, carried as trailers. */
  coAuthors: string[];
}

/**
 * The commit a merged Ticket leaves on the base branch.
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
  /**
   * Where the work is, left out when there is no worktree to send anyone to:
   * a Ticket that failed at setup never had one created, and a path that is not
   * on disk reads as if something else had gone wrong.
   */
  worktree?: string;
  pullRequest?: number;
  /** Failing Check output, unmet criteria, or a CI log excerpt. */
  evidence: string;
  /** Whether the Ticket's fix budget had already been spent when this failure came. */
  fixUsed?: boolean;
}

export function handoffComment(handoff: HandoffComment): string {
  const location = [
    `Branch \`${handoff.branch}\``,
    ...(handoff.worktree === undefined ? [] : [`worktree \`${handoff.worktree}\``]),
    ...(handoff.pullRequest === undefined ? [] : [`PR #${handoff.pullRequest} (draft)`]),
  ].join(" · ");

  // The budget clause is the difference between one bad Stage and a Ticket the
  // pipeline already had a second go at, which is what a human needs to know.
  const budget = handoff.fixUsed ? ", after the fix budget was used" : "";

  const lines = [
    HANDOFF_MARKER,
    `**Handed off.** Failed at **${handoff.stage}**${budget}.`,
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

/** A Note, and where it came from, as both Note templates announce it. */
export interface NoteSubject {
  /** The Ticket whose Stage made the finding. */
  origin: number;
  stage: StageName;
  note: string;
  /**
   * The Ticket this was meant to be a comment on, when that Ticket would not
   * take it. Set only on the issue a refused comment falls back to, so triage
   * can see the link the Note was reaching for.
   */
  intended?: number;
}

/** {@link UNCHECKED_BOX}, over every line of a Note rather than the first. */
const NOTE_CHECKBOX = new RegExp(UNCHECKED_BOX, "gm");

/**
 * A Note's prose, with every checkbox defused.
 *
 * `- [ ]` is Acceptance Criteria to everything that reads a Ticket: the
 * `no-criteria` guard counts one as a usable Ticket, verify grades it, and the
 * merge ticks it. A Note is prose a human should read, not work anyone
 * promised, so its boxes are escaped into the text they were meant to be.
 * Brackets anywhere but at the head of a list item are left alone, because that
 * is the only shape those readers recognise.
 */
function escapeCheckboxes(note: string): string {
  return note.replaceAll(NOTE_CHECKBOX, (_, bullet: string) => `${bullet}\\[ \\]`);
}

/** Where the Note came from, in the one line both Note templates open with. */
function noteProvenance({ origin, stage }: NoteSubject): string {
  return `From #${origin} ${stage}`;
}

/** One Note, posted on the Ticket it names. */
export function noteComment(subject: NoteSubject): string {
  return [
    NOTE_MARKER,
    noteProvenance(subject),
    "",
    escapeCheckboxes(subject.note.trim()),
    "",
  ].join("\n");
}

/** How much of a Note's first sentence fits an issue list untruncated. */
const TITLE_LIMIT = 72;

/**
 * What a title has to lose from the front of a Note's first line: a heading's
 * hashes, a bullet, the stars around bold text. Deliberately its own copy of
 * what `guards.ts` strips off a `Blocked by` line — that one reads a document a
 * human wrote in a shape the guard has to recognise, where this one is
 * tidying an agent's prose, and the two are free to drift.
 */
const TITLE_DECORATION = /^[\s>#*_+-]+/;

/** The first sentence, if the Note opens with one short enough to end. */
const FIRST_SENTENCE = /^(.+?[.!?])(?:\s|$)/;

/** A Note's opening line, which is as much of it as any summary has room for. */
function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim();
}

/** `text`, or as much of it as fits with an ellipsis standing in for the rest. */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}\u2026`;
}

/**
 * The title a Note's issue gets: its first sentence, trimmed to be read at a
 * glance.
 *
 * Derived rather than asked for. A Stage that writes a title as well as a note
 * writes two things badly, and triage is where a Note becomes a Ticket with a
 * title worth having — this one only has to be enough to open the issue on.
 */
function noteTitle(subject: NoteSubject): string {
  const stripped = firstLine(subject.note).replace(TITLE_DECORATION, "").trim();
  const sentence = FIRST_SENTENCE.exec(stripped)?.[1] ?? stripped;
  const title = sentence.replace(/\.$/, "").trim();

  return title === ""
    ? `Note from #${subject.origin} ${subject.stage}`
    : truncate(title, TITLE_LIMIT);
}

/** The issue a Note opens when it names no Ticket. The label is the caller's. */
export function noteIssue(subject: NoteSubject): { title: string; body: string } {
  const provenance =
    subject.intended === undefined
      ? noteProvenance(subject)
      : `${noteProvenance(subject)}, meant for #${subject.intended}, which would not take the comment`;

  return {
    title: noteTitle(subject),
    body: [provenance, "", escapeCheckboxes(subject.note.trim()), ""].join("\n"),
  };
}

export interface RunSummary {
  runId: string;
  durationMs: number;
  outcomes: TicketOutcome[];
  /**
   * Why the Run stopped, and with it whatever it can still say about the
   * Frontier. Only a Run has a Frontier, so `ticket <n>` leaves this out and
   * the summary says nothing about what else was pickable.
   */
  stop?: RunStop;
}

/** Every summary row is `<verb> #<n> <detail>`, so the numbers line up. */
const VERB_WIDTH = 9;

/**
 * What a Run prints when it ends. One line per Ticket, then why the Run
 * stopped — the Frontier is empty, everything left on it is blocked, or the
 * rate limit released a Ticket and the Run went no further.
 */
export function runSummary({ runId, durationMs, outcomes, stop }: RunSummary): string {
  const rows = [
    ...outcomes.flatMap(ticketRows),
    // Only a Run that reached the end of the Frontier can name what was held
    // back all Run, so only that stop carries candidates to skip.
    ...(stop?.reason === "frontier"
      ? stop.blocked.map((ticket) => row("skipped", ticket, "blocked"))
      : []),
  ];

  return [
    `agent-pipeline run ${runId} · ${Math.round(durationMs / 60_000)}m`,
    "",
    ...(rows.length === 0 ? ["  nothing to do"] : rows),
    "",
    ...(stop === undefined ? [] : [lastLine(stop)]),
    "",
  ].join("\n");
}

/** The one line that says why the Run stopped. */
function lastLine(stop: RunStop): string {
  if (stop.reason === "rate-limited") return "Rate limited.";
  return stop.blocked.length === 0 ? "Frontier empty." : "Frontier blocked.";
}

/**
 * One Ticket's lines: what happened to it, then every Note its Stages made.
 *
 * The Notes follow their own Ticket rather than being gathered at the end, so a
 * Run that took six Tickets still says which one noticed what.
 */
function ticketRows(outcome: TicketOutcome): string[] {
  return [
    ticketRow(outcome),
    ...(outcome.outcome === "skipped" ? [] : outcome.notes.map(noteRow)),
  ];
}

/**
 * How much of a Note a summary line shows before pointing at GitHub for the
 * rest. Chosen so a `noted` row is no longer than the Ticket rows it sits
 * among, which is what makes the column of numbers worth lining up.
 */
const NOTE_WIDTH = 40;

/** One Note's line: where it went, where it came from, and the gist of it. */
function noteRow({ origin, stage, issue, opened, note }: RoutedNote): string {
  const destination = opened ? "new" : "comment";
  return row(
    "noted",
    issue,
    `${destination} · from #${origin} ${stage} · ${truncate(firstLine(note), NOTE_WIDTH)}`,
  );
}

/** One Ticket's line in a summary: what happened to it, and where to look. */
function ticketRow(outcome: TicketOutcome): string {
  switch (outcome.outcome) {
    case "merged":
      return row("merged", outcome.ticket, `${outcome.title} (PR #${outcome.pullRequest})`);
    case "handed-off":
      return row(
        "handed",
        outcome.ticket,
        `${outcome.title} · ${outcome.stage} · ${outcome.failure}`,
      );
    case "released":
      // Nothing for a human to do, so the row says only where the limit landed
      // and leaves the rest to the Run that resumes the Ticket.
      return row("released", outcome.ticket, `${outcome.title} · rate limit at ${outcome.stage}`);
    case "skipped":
      // The reason is the guard's own word for it, which is also the marker on
      // the warning comment the human is being pointed at.
      return row("skipped", outcome.ticket, outcome.reason);
  }
}

function row(verb: string, ticket: number, detail: string): string {
  return `  ${verb.padEnd(VERB_WIDTH)}#${ticket} ${detail}`;
}
