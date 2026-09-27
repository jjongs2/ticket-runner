/**
 * The exact shapes the pipeline writes to GitHub. `docs/templates/` is the
 * source of truth for these; change it there first.
 */

import { UNCHECKED_BOX } from "./acceptance-criteria.js";
import type { GuardReason } from "./guards.js";
import type { HostKind } from "./host.js";
import type { FailurePoint } from "./lifecycle.js";
import type { NoteText, NotingStage, RoutedNote } from "./notes.js";
import type { TicketOutcome } from "./orchestrator.js";
import type { IssueComment, SquashCommit } from "./ports/tracker.js";
import type { KeptTranscripts } from "./ports/workspace.js";
import type { RunStop } from "./run.js";
import { type Criterion, type Verdict, countStatuses } from "./verdict.js";

/** How the pipeline finds its own hand-off comment again. */
export const HANDOFF_MARKER = "<!-- ticket-runner:handoff -->";

/** What a Note comment is signed with. Nothing looks it up; a human reads it. */
export const NOTE_MARKER = "<!-- ticket-runner:note -->";

/**
 * How the pipeline finds the standing Notes issue again.
 *
 * Distinct from {@link NOTE_MARKER}, which signs the Note comments this issue
 * collects: one marks the container, the other marks what is in it, and a
 * lookup that confused them would write Notes into a Note.
 *
 * It sits in the issue's body rather than in a comment, which is the one place
 * a marker survives a human tidying the thread, and it is the only thing the
 * lookup trusts. The title is a fast path and nothing more.
 */
export const NOTES_ISSUE_MARKER = "<!-- ticket-runner:notes-issue -->";

/**
 * The title the standing Notes issue is opened with.
 *
 * Written once, at the moment it is opened, and never rewritten: a human who
 * renames it has said something about this issue, and the marker still finds
 * it.
 */
export const NOTES_ISSUE_TITLE = "Notes from the pipeline";

/** How the pipeline finds a warning it has already posted: one marker per reason. */
export function guardMarker(reason: GuardReason): string {
  return `<!-- ticket-runner:guard:${reason} -->`;
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
 * Every comment carrying `marker`, oldest first.
 *
 * The marker is the first line of every pipeline comment and never changes,
 * which is the whole point of it: this is how the pipeline finds what it has
 * already written rather than writing it again. Most markers are on one comment
 * per Ticket, but a hand-off is a comment of its own every time a Ticket is
 * handed off, so the marker alone does not promise there is only one.
 */
export function findMarkedComments(comments: IssueComment[], marker: string): IssueComment[] {
  return comments.filter((comment) => carriesMarker(comment.body, marker));
}

/** Whether a body opens with `marker`, which is the whole of how one is read. */
function carriesMarker(body: string, marker: string): boolean {
  return body.trimStart().startsWith(marker);
}

/**
 * The newest comment carrying `marker`, for the markers one comment wears at a
 * time.
 *
 * The newest rather than the first, because "one at a time" is not "one ever": a
 * Ticket taken back from a human starts a progress comment of its own beside the
 * table the human read, and the Run writing now must edit the one it just
 * posted rather than the one it deliberately left alone.
 */
export function findMarkedComment(
  comments: IssueComment[],
  marker: string,
): IssueComment | undefined {
  return findMarkedComments(comments, marker).at(-1);
}

/** Whether a candidate has already been warned about this. */
export function hasGuardWarning(comments: IssueComment[], reason: GuardReason): boolean {
  return findMarkedComment(comments, guardMarker(reason)) !== undefined;
}

/** The one warning a skipped candidate gets. Two sentences: the reason, the fix. */
export function guardComment(reason: GuardReason): string {
  return [
    guardMarker(reason),
    `**Skipped by ticket-runner.** ${GUARD_SENTENCES[reason]}`,
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
  /** The Host the Run is on, which decides whether its run directory is worth naming. */
  host: HostKind;
}

export function pullRequestBody({ ticket, verdict, runId, host }: PullRequestBody): string {
  const criteria = verdict.criteria.map((criterion) => {
    const line = `- ${STATUS_ICON[criterion.status]} ${criterion.text}`;
    return criterion.status === "met" ? line : `${line} — ${criterion.evidence}`;
  });

  // A merged Ticket keeps no transcripts on the remote, so the run directory is
  // the only place they are, and a cloud Host's goes with its session.
  const where =
    host === "workstation" ? `\`.ticket-runner/runs/${runId}/${ticket}/\`` : undefined;

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
    runLine(runId, where),
    "",
  ].join("\n");
}

export interface DraftPullRequestBody {
  ticket: number;
  stage: FailurePoint;
  failure: string;
  runId: string;
  /** Where the hand-off kept the Stages' transcripts on the remote, when it kept any. */
  transcripts?: KeptTranscripts;
}

/**
 * The body of the draft PR a hand-off leaves behind, whether it opened the PR
 * or made an open one a draft: what a human needs from it is the hand-off, not
 * a Verdict.
 */
export function draftPullRequestBody({
  ticket,
  stage,
  failure,
  runId,
  transcripts,
}: DraftPullRequestBody): string {
  return [
    `Closes #${ticket}`,
    "",
    `**Handed off at ${stage}.** ${failure}`,
    "",
    `See the hand-off comment on #${ticket} for the branch, worktree and evidence.`,
    "",
    runLine(runId, transcripts === undefined ? undefined : keptPlace(transcripts)),
    "",
  ].join("\n");
}

/**
 * The line both pull request bodies end with: the Run, and where its
 * transcripts are when there is somewhere that outlives the Host to point at.
 */
function runLine(runId: string, where: string | undefined): string {
  const run = `Run \`${runId}\``;
  return where === undefined ? run : `${run} · transcripts in ${where}`;
}

/** Where a hand-off kept the transcripts, as every shape that names it spells it. */
function keptPlace(transcripts: KeptTranscripts): string {
  return `\`${transcripts.path}\` on the \`${transcripts.branch}\` branch`;
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
   * Whether the remote has the branch, which is where the work still is once
   * the Host that did it is gone. Said only when it is so.
   */
  onRemote?: boolean;
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
  /** Where the Stages' transcripts were kept on the remote, when any were. */
  transcripts?: KeptTranscripts;
}

export function handoffComment(handoff: HandoffComment): string {
  const location = [
    `Branch \`${handoff.branch}\`${handoff.onRemote === true ? " on the remote" : ""}`,
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
    ...(handoff.transcripts === undefined
      ? []
      : [`- Transcripts: ${keptPlace(handoff.transcripts)}`]),
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

/**
 * What a hand-off comment gains when the pipeline takes the Ticket on again.
 *
 * Under the marker rather than at the end, so a reader meets it before the
 * failure it qualifies, and italic so it reads as the pipeline talking about
 * the comment rather than as another line of the hand-off.
 */
export const HANDOFF_TAKEN_LINE = "_Taken again by a later Run; this hand-off is history._";

/**
 * A hand-off comment with {@link HANDOFF_TAKEN_LINE} under its marker, or
 * nothing when the comment already carries the line.
 *
 * Nothing else about the comment is touched: the failure, the location and the
 * evidence are why the hand-off is worth keeping, and only their currency has
 * changed. Nothing when there is nothing to add is how the caller knows to
 * spend no tracker call on it, which is also what stops a Ticket claimed twice
 * stacking the line.
 *
 * The line is looked for directly under the marker rather than anywhere in the
 * comment, so evidence that happens to quote it is not read as a mark.
 */
export function handoffTakenComment(body: string): string | undefined {
  const marked = `${HANDOFF_MARKER}\n${HANDOFF_TAKEN_LINE}`;
  if (body.includes(marked)) return undefined;
  return body.replace(HANDOFF_MARKER, `${marked}\n`);
}

/** A Note, and where it came from, as the comment it becomes announces it. */
export interface NoteSubject {
  /** The Ticket whose Stage made the finding. */
  origin: number;
  stage: NotingStage;
  note: NoteText;
  /**
   * The Ticket this was meant to be a comment on, when that Ticket would not
   * take it or nobody would read it there. Set only on a Note that fell back to
   * the standing Notes issue, so triage can see the link the Note was reaching
   * for.
   */
  intended?: number;
  /**
   * Why `intended` did not get the comment, as the words after `which`: `is
   * closed`, `is claimed`, `is a Spec`. Absent when the tracker refused the
   * write, which is the one reason the pipeline cannot name.
   */
  because?: string;
}

/** {@link UNCHECKED_BOX}, over every line of a Note rather than the first. */
const NOTE_CHECKBOX = new RegExp(UNCHECKED_BOX, "gm");

/**
 * One part of a Note's prose, with every checkbox defused.
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

/**
 * Where the Note came from, in the one line every Note comment opens with.
 *
 * A Note that reached the standing Notes issue carries the Ticket it was
 * reaching for and why that Ticket did not get it, because the comment is all
 * triage has to go on: without the number, a finding about #7 read on the
 * standing issue has lost the only thing that placed it.
 */
function noteProvenance({ origin, stage, intended, because }: NoteSubject): string {
  const from = `From #${origin} ${stage}`;
  if (intended === undefined) return from;
  return `${from}, meant for #${intended}, which ${because ?? "would not take the comment"}`;
}

/**
 * The labelled paragraph one part of a Note becomes, or nothing when the Stage
 * left that part out or blank.
 */
function labelledPart(label: string, text: string | undefined): string[] {
  if (text === undefined || text.trim() === "") return [];
  return [`**${label}**: ${escapeCheckboxes(text.trim())}`];
}

/**
 * One Note, as a comment on the Ticket it names or on the standing Notes issue:
 * the summary in bold, then each part the Stage wrote under a label of its own.
 *
 * The summary is folded onto one line so the bold around it holds: a blank
 * line inside it would end the paragraph and leave the asterisks showing.
 */
export function noteComment(subject: NoteSubject): string {
  const { summary, evidence, impact, next } = subject.note;
  const paragraphs = [
    `**${escapeCheckboxes(summary.trim().replaceAll(/\s+/g, " "))}**`,
    ...labelledPart("Evidence", evidence),
    ...labelledPart("Impact", impact),
    ...labelledPart("Next", next),
  ];
  return [NOTE_MARKER, noteProvenance(subject), "", paragraphs.join("\n\n"), ""].join("\n");
}

/** Whether an issue's body says it is the standing Notes issue. */
export function isNotesIssue(body: string): boolean {
  return carriesMarker(body, NOTES_ISSUE_MARKER);
}

/**
 * The standing Notes issue, as the Note that needed one opens it. The label is
 * the caller's.
 *
 * Fixed text: the Notes themselves are comments under it, and nothing the
 * pipeline writes afterwards touches this body. What is written here is for
 * triage — what the issue is, and what emptying it means — because a human
 * meeting an issue the pipeline opened by itself is owed both.
 */
export function notesIssue(): { title: string; body: string } {
  return {
    title: NOTES_ISSUE_TITLE,
    body: [
      NOTES_ISSUE_MARKER,
      "**Notes from the pipeline.** Every finding a Stage could not post on a " +
        "Ticket arrives here as a comment: one that named no Ticket, one whose " +
        "Ticket would have buried it, and one whose Ticket refused the comment. " +
        "Each comment says which Ticket and Stage found it.",
      "",
      "Triage empties this issue by hand: promote what deserves a Ticket, record " +
        "the promotion in this body, and close the issue once the body accounts " +
        "for every comment. The next Note after that opens a fresh one, so only " +
        "ever one of these is open.",
      "",
    ].join("\n"),
  };
}

export interface RunSummary {
  /** The Version the Run ran, which is what its transcripts are stamped with. */
  version: string;
  runId: string;
  durationMs: number;
  outcomes: TicketOutcome[];
  /**
   * The line saying a newer Version is out, where one is. Above the header
   * rather than below it: the Run already said this hours ago, at the top of a
   * log this summary is the bottom of (ADR-0007).
   */
  newer?: string;
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
 * stopped — the Frontier is empty, everything left on it is blocked, the rate
 * limit released a Ticket and the Run went no further, or a human stopped it.
 */
export function runSummary({
  version,
  runId,
  durationMs,
  outcomes,
  newer,
  stop,
}: RunSummary): string {
  const rows = [
    ...outcomes.flatMap(ticketRows),
    // Only a Run that reached the end of the Frontier can name what was held
    // back all Run, so only that stop carries candidates to skip.
    ...(stop?.reason === "frontier"
      ? stop.blocked.map((ticket) => row("skipped", ticket, "blocked"))
      : []),
  ];

  return [
    ...(newer === undefined ? [] : [newer]),
    `ticket-runner ${version} run ${runId} · ${Math.round(durationMs / 60_000)}m`,
    "",
    ...(rows.length === 0 ? ["  nothing to do"] : rows),
    "",
    ...(stop === undefined ? [] : [lastLine(stop)]),
    "",
  ].join("\n");
}

/** The one line that says why the Run stopped. */
function lastLine(stop: RunStop): string {
  switch (stop.reason) {
    case "rate-limited":
      return "Rate limited.";
    case "stopped":
      return `Stopped at ${clockTime(stop.at)} · ${holding(stop.busy)}.`;
    case "frontier":
      return stop.blocked.length === 0 ? "Frontier empty." : "Frontier blocked.";
  }
}

/**
 * The minute a Stop arrived, in UTC — the clock the run id on the first line of
 * the summary is already written in, so the two can be read against each other.
 */
function clockTime(at: string): string {
  return at.slice(11, 16);
}

/** What the Lanes were holding when the Stop arrived, and what to call none. */
function holding(busy: number[]): string {
  if (busy.length === 0) return "nothing to finish";
  return `finishing ${busy.map((ticket) => `#${ticket}`).join(" ")}`;
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

/** A Note summary's opening line, which is as much of it as a Run summary has room for. */
function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim();
}

/** `text`, or as much of it as fits with an ellipsis standing in for the rest. */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}\u2026`;
}

/**
 * How much of a Note a summary line shows before pointing at GitHub for the
 * rest. Chosen so a `noted` row is no longer than the Ticket rows it sits
 * among, which is what makes the column of numbers worth lining up.
 */
const NOTE_WIDTH = 40;

/** One Note's line: where it went, where it came from, and the gist of it. */
function noteRow({ origin, stage, issue, opened, summary }: RoutedNote): string {
  const destination = opened ? "new" : "comment";
  return row(
    "noted",
    issue,
    `${destination} · from #${origin} ${stage} · ${truncate(firstLine(summary), NOTE_WIDTH)}`,
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
