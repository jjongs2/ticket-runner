/**
 * The exact shapes the pipeline writes to GitHub. `docs/templates/` is the
 * source of truth for these; change it there first.
 */

import type { GuardReason } from "./guards.js";
import type { FailurePoint } from "./lifecycle.js";
import type { RoutedNote } from "./notes.js";
import type { TicketOutcome } from "./orchestrator.js";
import type { StageName } from "./ports/agent-runner.js";
import type { IssueComment, SquashCommit } from "./ports/tracker.js";
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
  /** Whether the Ticket's fix budget had already been spent when this failure came. */
  fixUsed?: boolean;
}

export function handoffComment(handoff: HandoffComment): string {
  const location = [
    `Branch \`${handoff.branch}\``,
    `worktree \`${handoff.worktree}\``,
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
}

/** A task list item at the start of a line, which is what a guard reads. */
const NOTE_CHECKBOX = /^([ \t]*[-*+] )\[ \]/gm;

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

/** How much of a Note's first sentence fits an issue list unhelpfully truncated. */
const TITLE_LIMIT = 72;

/** Whatever a heading, a list item or bold text puts in front of the words. */
const DECORATION = /^[\s>#*_+-]+/;

/** The first sentence, if the Note opens with one short enough to end. */
const FIRST_SENTENCE = /^(.+?[.!?])(?:\s|$)/;

/**
 * The title a Note's issue gets: its first sentence, trimmed to be read at a
 * glance.
 *
 * Derived rather than asked for. A Stage that writes a title as well as a note
 * writes two things badly, and triage is where a Note becomes a Ticket with a
 * title worth having — this one only has to be enough to open the issue on.
 */
function noteTitle(subject: NoteSubject): string {
  const first = subject.note.split("\n").find((line) => line.trim() !== "") ?? "";
  const stripped = first.replace(DECORATION, "").trim();
  const sentence = FIRST_SENTENCE.exec(stripped)?.[1] ?? stripped;
  const title = sentence.replace(/\.$/, "").trim();

  if (title === "") return `Note from #${subject.origin} ${subject.stage}`;
  return title.length <= TITLE_LIMIT
    ? title
    : `${title.slice(0, TITLE_LIMIT - 1).trimEnd()}\u2026`;
}

/** The issue a Note opens when it names no Ticket. The label is the caller's. */
export function noteIssue(subject: NoteSubject): { title: string; body: string } {
  return {
    title: noteTitle(subject),
    body: [noteProvenance(subject), "", escapeCheckboxes(subject.note.trim()), ""].join("\n"),
  };
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
    ...outcomes.flatMap(ticketRows),
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
  const gist = (note.split("\n").find((line) => line.trim() !== "") ?? "").trim();
  return row(
    "noted",
    issue,
    `${opened ? "new" : "comment"} · from #${origin} ${stage} · ${
      gist.length <= NOTE_WIDTH ? gist : `${gist.slice(0, NOTE_WIDTH - 1).trimEnd()}\u2026`
    }`,
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
