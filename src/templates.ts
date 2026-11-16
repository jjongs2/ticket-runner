/**
 * The exact shapes the pipeline writes to GitHub. `docs/templates/` is the
 * source of truth for these; change it there first.
 */

import { UNCHECKED_BOX } from "./acceptance-criteria.js";
import {
  type Billing,
  CREDENTIAL_WORDS,
  type Credential,
  type StrayStage,
  emptyBilling,
} from "./credential.js";
import type { GuardReason } from "./guards.js";
import { splitMessage } from "./failure-message.js";
import type { FailurePoint } from "./lifecycle.js";
import { logTail } from "./log-tail.js";
import type { NoteText, NotingStage, RoutedNote } from "./notes.js";
import type { ReleaseCause, TicketOutcome } from "./orchestrator.js";
import type { IssueComment, SquashCommit } from "./ports/tracker.js";
import type { KeptTranscripts } from "./ports/workspace.js";
import type { RunStop } from "./run.js";
import type { BranchProse } from "./title.js";
import type { Verdict } from "./verdict.js";

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
 * per Ticket, but a hand-off that writes one writes a comment of its own every
 * time a Ticket is handed off, so the marker alone does not promise there is only one.
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
 * Ticket taken back from a human with a hand-off comment to mark starts a
 * progress comment of its own beside the table the human read, and the Run
 * writing now must edit the one it just posted rather than the one it
 * deliberately left alone.
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

/**
 * What the `no-criteria` guard says of a Ticket whose checkboxes are all
 * ticked. Told only that it has no criteria, a human looking at a list of them
 * reads the comment as wrong.
 */
function allTickedSentences(ticked: number): string {
  const boxes = ticked === 1 ? "its one checkbox is" : `all ${ticked} of its checkboxes are`;
  return (
    `No \`- [ ]\` acceptance criteria found: ${boxes} already ticked. ` +
    "Untick each criterion not yet done, then re-run."
  );
}

/**
 * The one warning a skipped candidate gets. Two sentences: the reason, the fix.
 *
 * `ticked` is how many ticked checkboxes the Ticket carries, which only the
 * `no-criteria` warning reads.
 */
export function guardComment(reason: GuardReason, ticked = 0): string {
  const sentences =
    reason === "no-criteria" && ticked > 0 ? allTickedSentences(ticked) : GUARD_SENTENCES[reason];
  return [guardMarker(reason), `**Skipped by ticket-runner.** ${sentences}`, ""].join("\n");
}

export interface PullRequestBody {
  ticket: number;
  /** The latest body a Stage answered for the branch, when one has. */
  body?: string;
}

/**
 * The body of a pipeline pull request: the one `Closes` the pipeline writes,
 * and below it the body a Stage answered in the Target's shape or the `pr`
 * skill's. The pipeline adds nothing of its own: the verify Stage's progress
 * row carries the verdict, and the merge ticks the met criteria on the Ticket.
 */
export function pullRequestBody({ ticket, body }: PullRequestBody): string {
  const closes = `Closes #${ticket}`;
  return body === undefined ? `${closes}\n` : `${closes}\n\n${body}\n`;
}

export interface DraftPullRequestBody {
  ticket: number;
  stage: FailurePoint;
  /**
   * As the hand-off comment's: one line, or an unexpected error's whole
   * message, whose output the body shows as evidence the way the comment does.
   */
  failure: string;
  runId: string;
  /** Where the hand-off kept the Stages' transcripts, when there are any. */
  transcripts?: TranscriptsPlace;
}

/**
 * The body of the draft pull request a hand-off leaves behind, whether it
 * opened the pull request or made an open one a draft: what a human needs from
 * it is the hand-off, not a verdict.
 */
export function draftPullRequestBody({
  ticket,
  stage,
  failure,
  runId,
  transcripts,
}: DraftPullRequestBody): string {
  const shown = failureShown(failure, "");
  return [
    `Closes #${ticket}`,
    "",
    `**Handed off at ${stage}.** ${shown.line}`,
    "",
    ...evidenceBlock(shown.evidence),
    `See the hand-off comment on #${ticket} for the branch, worktree and evidence.`,
    "",
    runLine(runId, transcripts),
    "",
  ].join("\n");
}

/**
 * A hand-off's failure as one line, and the evidence that goes with it.
 *
 * The failures the pipeline expects already come as one line and their output
 * as evidence. An unexpected error comes as its message whole — the command,
 * how it exited, and everything it printed — so its first line is the failure
 * and the rest is evidence, ahead of any the hand-off carried already.
 */
function failureShown(failure: string, evidence: string): { line: string; evidence: string } {
  const { line, output } = splitMessage(failure);
  return {
    line,
    evidence: [output, evidence.trim()].filter((part) => part !== "").join("\n\n"),
  };
}

/**
 * Evidence folded away and fenced, because it is raw output that would
 * otherwise be read as Markdown; nothing at all when there is none.
 */
function evidenceBlock(evidence: string): string[] {
  if (evidence === "") return [];
  return ["<details><summary>Evidence</summary>", "", "```", evidence, "```", "", "</details>", ""];
}

/**
 * Where a hand-off says the Stages' transcripts are: on the remote beside the
 * Ticket's state, or kept off it on the Host, which a workstation outlives and
 * a cloud Host's VM does not. A workstation's directory is named relative to
 * the checkout, so a public comment does not publish the Host's home path.
 */
export type TranscriptsPlace =
  | ({ on: "remote" } & KeptTranscripts)
  | { on: "workstation"; path: string }
  | { on: "cloud" };

/**
 * The line a draft pull request's body ends with: the Run, and where its
 * transcripts are when there are any.
 */
function runLine(runId: string, transcripts: TranscriptsPlace | undefined): string {
  const run = `Run \`${runId}\``;
  if (transcripts === undefined) return run;
  // A directory is led into with `in`; the cloud Host's phrase names none.
  const lead = transcripts.on === "cloud" ? "transcripts" : "transcripts in";
  return `${run} · ${lead} ${placeOf(transcripts)}`;
}

/** Where the transcripts are, as every shape that names it spells it. */
function placeOf(transcripts: TranscriptsPlace): string {
  switch (transcripts.on) {
    case "remote":
      return `\`${transcripts.path}\` on the \`${transcripts.branch}\` branch`;
    case "workstation":
      return `\`${transcripts.path}\` on the Host, kept off the remote`;
    case "cloud":
      return "kept off the remote, on the cloud Host, so they go with its VM";
  }
}

export interface SquashCommitMessage extends Pick<BranchProse, "problem" | "solution"> {
  ticket: number;
  /** The pull request number, appended to the subject as GitHub would. */
  pullRequest: number;
  /** The pull request title, which is the subject that lands on the base branch. */
  title: string;
  /** The verdict the merge is made on, whose unverifiable criteria the body names. */
  verdict: Verdict;
  /** The branch's commit subjects, oldest first, which stand in for a solution no Stage answered. */
  commits: string[];
  /** Unique `Co-authored-by` values from the branch, carried as trailers. */
  coAuthors: string[];
}

/**
 * The commit a merged Ticket leaves on the base branch.
 *
 * It opens with the problem and the solution a Stage answered, so `git log`
 * says why without the Ticket. Where no Stage answered a solution, the
 * branch's commit subjects say what changed in its place; nothing is made up
 * for either.
 *
 * An unverifiable criterion's reason is kept nowhere on the Ticket, so it is
 * carried here, one line per criterion. `git log` renders no HTML, so nothing
 * is folded away.
 */
export function squashCommit({
  ticket,
  pullRequest,
  title,
  problem,
  solution,
  verdict,
  commits,
  coAuthors,
}: SquashCommitMessage): SquashCommit {
  const paragraphs = [
    [`Closes #${ticket}`],
    ...(problem === undefined ? [] : [wrapLines(problem)]),
    solution === undefined ? commits.map((subject) => `- ${subject}`) : wrapLines(solution),
    unverifiedLines(verdict),
    // What GitHub's default message would have carried, now carried by hand.
    coAuthors.map((author) => `Co-authored-by: ${author}`),
  ].filter((lines) => lines.length > 0);
  return {
    subject: `${title} (#${pullRequest})`,
    body: `${paragraphs.map((lines) => lines.join("\n")).join("\n\n")}\n`,
  };
}

/** The unverifiable criteria with their evidence on one line each, under a heading; nothing when there are none. */
function unverifiedLines(verdict: Verdict): string[] {
  const unverifiable = unverifiableLines(verdict);
  return unverifiable.length === 0 ? [] : ["Unverified:", ...unverifiable];
}

/**
 * One `- <criterion> — <evidence>` line per unverifiable criterion, each joined
 * into one line: what the squash commit carries, and what a hand-off on a
 * Target that merges by hand says in its place.
 */
function unverifiableLines(verdict: Verdict): string[] {
  return verdict.criteria
    .filter((criterion) => criterion.status === "unverifiable")
    .map((criterion) => `- ${oneLine(criterion.text)} — ${oneLine(criterion.evidence)}`);
}

/** Text with its line breaks, and the space around them, joined into single spaces. */
function oneLine(text: string): string {
  return text.trim().replace(/\s*\n\s*/g, " ");
}

/** How wide a commit body's line may run, as git's own convention has it. */
const COMMIT_BODY_COLUMNS = 72;

/**
 * Prose for a commit body, each line wider than {@link COMMIT_BODY_COLUMNS}
 * broken at its spaces. The lines the Stage wrote stay as they are, so a list
 * stays a list, and a word wider than the limit is left whole.
 */
export function wrapLines(text: string): string[] {
  return text.split("\n").flatMap((line) => wrapLine(line.trimEnd()));
}

function wrapLine(line: string): string[] {
  if (columns(line) <= COMMIT_BODY_COLUMNS) return [line];
  // A line's indent belongs to its first word, so the break never lands in it.
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  const words = line.slice(indent.length).split(/ +/);
  const lines: string[] = [];
  let current = indent + (words.shift() ?? "");
  for (const word of words) {
    const joined = `${current} ${word}`;
    if (columns(joined) <= COMMIT_BODY_COLUMNS) {
      current = joined;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

/** How many columns a terminal gives `text`: two for a wide character such as Hangul, one for any other. */
export function columns(text: string): number {
  let width = 0;
  for (const character of text) width += isWide(character.codePointAt(0) ?? 0) ? 2 : 1;
  return width;
}

/** East Asian Wide and Fullwidth code points, the ones a terminal draws two columns wide. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compatibility Jamo, CJK compatibility
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Pictographs and emoticons
  [0x1f680, 0x1f6ff], // Transport and map symbols
  [0x1f900, 0x1f9ff], // Supplemental pictographs
  [0x20000, 0x3fffd], // CJK unified ideographs extensions B onwards
];

function isWide(codePoint: number): boolean {
  return WIDE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

export interface HandoffComment {
  stage: FailurePoint;
  /**
   * One line a human can read in a notification, or an unexpected error's
   * whole message, whose first line is shown here and the rest as evidence.
   */
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
  /** Where the Stages' transcripts are, when there are any. */
  transcripts?: TranscriptsPlace;
  /**
   * Why the Stage this hand-off is for committed nothing, as it answered it in
   * `noCommitReason`. Set only for an implement or fix Stage that finished and
   * left no new commit, which is the one hand-off the reason explains.
   */
  reason?: string;
}

export function handoffComment(handoff: HandoffComment): string {
  const location = whereTheWorkIs(
    handoff,
    handoff.pullRequest === undefined ? undefined : `PR #${handoff.pullRequest} (draft)`,
  );

  // The budget clause is the difference between one bad Stage and a Ticket the
  // pipeline already had a second go at, which is what a human needs to know.
  const budget = handoff.fixUsed ? ", after the fix budget was used" : "";

  const shown = failureShown(handoff.failure, handoff.evidence);
  return [
    HANDOFF_MARKER,
    `**Handed off.** Failed at **${handoff.stage}**${budget}.`,
    "",
    `- Failure: ${shown.line}`,
    `- ${location}`,
    ...(handoff.transcripts === undefined
      ? []
      : [`- Transcripts: ${placeOf(handoff.transcripts)}`]),
    "",
    ...stageSaid(handoff.stage, handoff.reason),
    ...evidenceBlock(shown.evidence),
  ].join("\n");
}

/** The branch, the worktree and the pull request, as one line of a hand-off comment says them. */
function whereTheWorkIs(
  { branch, onRemote, worktree }: Pick<HandoffComment, "branch" | "onRemote" | "worktree">,
  pullRequest: string | undefined,
): string {
  return [
    `Branch \`${branch}\`${onRemote === true ? " on the remote" : ""}`,
    ...(worktree === undefined ? [] : [`worktree \`${worktree}\``]),
    ...(pullRequest === undefined ? [] : [pullRequest]),
  ].join(" · ");
}

/** Why a Ticket handed off on a Target that merges by hand was handed off, in the words its row and log line give. */
export const LEFT_TO_HUMAN = "left to a human, as this Target merges by hand";

export interface MergeByHandComment extends Pick<HandoffComment, "branch" | "onRemote" | "worktree"> {
  /** The pull request a human is to merge, published ready for review. */
  pullRequest: number;
  /** The verdict the Ticket passed on, whose unverifiable criteria the comment lists. */
  verdict: Verdict;
}

/**
 * The hand-off of a Ticket that passed every gate on a Target that merges by
 * hand: nothing failed, so there is no failure line and no evidence block, and
 * the pull request is no draft.
 *
 * The unverifiable criteria and their evidence are what the squash commit
 * would have carried, had the pipeline merged. A human merging by hand gets
 * GitHub's own message instead, so they are said here, where that human reads
 * them. They are posted on the Ticket, whose comments are read for Acceptance
 * Criteria, so a line that could read as a checkbox is defused.
 *
 * Nothing when every criterion was met: the label, the progress comment's
 * `merge` row and the pull request linked from the Ticket already say all the
 * rest, the Run's account notifies nobody of its own comment, and once a human
 * merges, a comment still saying the pull request waits would be the closed
 * issue's last word.
 */
export function mergeByHandComment(handoff: MergeByHandComment): string | undefined {
  const unverifiable = unverifiableLines(handoff.verdict);
  if (unverifiable.length === 0) return undefined;
  return [
    HANDOFF_MARKER,
    `**Handed off.** PR #${handoff.pullRequest} passed every gate and waits for a human to merge it: this Target merges by hand.`,
    "",
    `- ${whereTheWorkIs(handoff, `PR #${handoff.pullRequest}`)}`,
    "",
    "**Unverifiable criteria:**",
    "",
    ...unverifiable.map(escapeCheckboxes),
  ].join("\n");
}

/**
 * The reason a Stage gave for committing nothing, as a paragraph of its own
 * between the hand-off's lines and its folded evidence, so a human reads it
 * without unfolding anything; nothing when it gave none.
 *
 * The Stage's prose is posted on the Ticket, whose comments are read for
 * Acceptance Criteria, so its checkboxes are defused as a Note's are.
 */
function stageSaid(stage: FailurePoint, reason: string | undefined): string[] {
  if (reason === undefined || reason.trim() === "") return [];
  return [`**The ${stage} Stage said:** ${escapeCheckboxes(reason.trim())}`, ""];
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

/** {@link UNCHECKED_BOX}, over every line of a Stage's prose rather than the first. */
const PROSE_CHECKBOX = new RegExp(UNCHECKED_BOX, "gm");

/**
 * A Stage's prose — one part of a Note, or the reason it gave for committing
 * nothing — with every checkbox defused.
 *
 * `- [ ]` is Acceptance Criteria to everything that reads a Ticket: the
 * `no-criteria` guard counts one as a usable Ticket, verify grades it, and the
 * merge ticks it. A Stage's prose is for a human to read, not work anyone
 * promised, so its boxes are escaped into the text they were meant to be.
 * Brackets anywhere but at the head of a list item are left alone, because that
 * is the only shape those readers recognise.
 */
function escapeCheckboxes(prose: string): string {
  return prose.replaceAll(PROSE_CHECKBOX, (_, bullet: string) => `${bullet}\\[ \\]`);
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

/**
 * How the Ticket's own branch failed, before the merge-base was graded: a Check
 * in its worktree, or CI on its pull request.
 */
export type BranchFailure =
  | { point: "checks"; command: string; output: string; timedOut: boolean }
  | {
      point: "ci";
      /** Which checks went red, as CI reported them. */
      summary: string;
      /** The tail of the failing jobs' logs, which a fix Stage would be handed; empty when none had one. */
      excerpt: string;
    };

/** A Check the base branch fails, as the pipeline's own Note reports it. */
export interface FailingBaseNote {
  /** The Ticket the failure released. */
  origin: number;
  /** How the Ticket's branch failed, which the Note quotes beside the merge-base's output. */
  onBranch: BranchFailure;
  baseBranch: string;
  /** The Ticket's branch, whose merge-base with the base branch `commit` is. */
  branch: string;
  /** The merge-base, in full, so it can be checked out as it is. */
  commit: string;
  command: string;
  output: string;
  timedOut: boolean;
}

/** The pipeline's Note's summary, which is also the Run summary's `noted` row. */
export function failingBaseSummary(baseBranch: string, command: string): string {
  return `The base branch \`${baseBranch}\` fails \`${command}\`.`;
}

/**
 * The one Note no Stage writes: a Ticket was released because the base branch
 * fails the Check its branch failed, so the defect is the base branch's and a
 * human has to mend it there.
 *
 * Signed and laid out as a Stage's Note is, so triage reads it the same way,
 * with the provenance naming the pipeline rather than a Stage. The tail of the
 * output is the one a CI log excerpt keeps, so long lines cannot push the Note
 * past what GitHub takes in a comment.
 *
 * The branch's own failure is quoted beside it, because only the command is
 * compared: a branch that fails the command differently is released all the
 * same, and its failure would otherwise be nowhere a human can read it. For CI
 * that is the failing jobs' logs as a fix Stage would be handed them, which are
 * tails already.
 */
export function failingBaseNote(note: FailingBaseNote): string {
  const { baseBranch, branch, commit, command, onBranch } = note;
  const where = `\`${command}\` ${note.timedOut ? "timed out" : "failed"} in a clean worktree at ${commit}, the merge-base of \`${branch}\` with \`${baseBranch}\`.`;
  const opening = "The branch's own failure, which need not be the same:";
  const branchPart =
    onBranch.point === "checks"
      ? quoted(
          `${opening} \`${onBranch.command}\` ${onBranch.timedOut ? "timed out" : "failed"} on \`${branch}\`.`,
          "The tail of the branch's output:",
          logTail(onBranch.output),
          "It printed nothing.",
        )
      : quoted(
          `${opening} CI on the pull request from \`${branch}\` reported ${onBranch.summary}.`,
          "The tail of the failing jobs' logs:",
          onBranch.excerpt.trim(),
          "No failing job had a log to quote.",
        );
  return [
    NOTE_MARKER,
    `From the pipeline, releasing #${note.origin} at ${onBranch.point}`,
    "",
    [
      `**${failingBaseSummary(baseBranch, command)}**`,
      `**Evidence**: ${quoted(where, "The tail of its output:", logTail(note.output), "It printed nothing.")}`,
      branchPart,
      `**Impact**: every Ticket whose branch inherits ${commit} fails the same Check. #${note.origin} was released with its fix budget as it was, and the Run claimed no more Tickets.`,
      `**Next**: mend \`${command}\` on \`${baseBranch}\`. The next Run takes the released Tickets up again from their state files, rebased onto \`${baseBranch}\` before their Checks.`,
    ].join("\n\n"),
    "",
  ].join("\n");
}

/**
 * A sentence of the pipeline's own and the output it introduces, or `ifEmpty`
 * in place of the introduction when there was no output.
 *
 * The output is fenced with more backticks than any run of them inside it, so a
 * fence the output prints cannot close it early, and only the output has its
 * checkboxes escaped, since the words around it are the pipeline's.
 */
function quoted(sentence: string, introduction: string, output: string, ifEmpty: string): string {
  if (output === "") return `${sentence} ${ifEmpty}`;
  const fence = "`".repeat(Math.max(3, ...[...output.matchAll(/`+/g)].map(([run]) => run.length + 1)));
  return `${sentence} ${introduction}\n\n${fence}\n${escapeCheckboxes(output)}\n${fence}`;
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
        "So does the pipeline's own Note about a base branch that fails a Check. " +
        "Each comment says which Ticket and Stage, or the pipeline, found it.",
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
  /** The version the Run ran, which is what its transcripts are stamped with. */
  version: string;
  runId: string;
  durationMs: number;
  /** What the Run's Stages were billed to, which its header names. */
  credential: Credential;
  outcomes: TicketOutcome[];
  /**
   * What the Run's Stages said they were billed: the spend or extra usage its
   * header gives, and every Stage that said it ran on something else, each
   * named in a row after its own Ticket's.
   */
  billing?: Billing;
  /**
   * The line saying a newer version is out, where one is. Above the header
   * rather than below it: the Run already said this hours ago, at the top of a
   * log this summary is the bottom of (ADR-0007).
   */
  newer?: string;
  /** Why the Run stopped, and with it whatever it can still say about the Frontier. */
  stop: RunStop;
}

/**
 * What a Release is put down to, in the words the Run summary, the log and
 * the progress comment share: the rate limit, a transient API failure, an API
 * key out of credit or past its spend limit, a base branch that fails the
 * Check the Ticket's branch failed, or GitHub or the git remote failing on its
 * own side.
 */
export const RELEASE_WORDS: Record<ReleaseCause, string> = {
  "rate-limited": "rate limit",
  "api-error": "API failure",
  "out-of-budget": "out of API budget",
  "failing-base": "failing base branch",
  github: "GitHub failure",
  remote: "remote unreachable",
};

/**
 * The same words, for a Run on `credential`. A rate limit on an `--api-key`
 * Run is the API's, not the subscription's, and is named so: what the human
 * looks at about it is the Console, not their plan.
 */
export function releaseWords(cause: ReleaseCause, credential: Credential): string {
  return cause === "rate-limited" && credential === "api-key"
    ? "API rate limit"
    : RELEASE_WORDS[cause];
}

/** Every summary row is `<verb> #<n> <detail>`, so the numbers line up. */
const VERB_WIDTH = 9;

/**
 * What a Run prints when it ends. One line per Ticket, then why the Run
 * stopped — the Frontier is empty, everything left on it is blocked, the rate
 * limit, a transient API failure, the API key's budget or a failing base branch
 * released a Ticket and the Run went no further, or a human stopped it.
 */
export function runSummary({
  version,
  runId,
  durationMs,
  credential,
  outcomes,
  billing = emptyBilling(),
  newer,
  stop,
}: RunSummary): string {
  const rows = [
    ...outcomes.flatMap((outcome) => [
      ...ticketRows(outcome, credential),
      ...billing.strays.filter((stray) => stray.ticket === outcome.ticket).map(billedRow),
    ]),
    // Only a Run that reached the end of the Frontier can name what was held
    // back all Run, so only that stop carries candidates to skip.
    ...(stop.reason === "frontier"
      ? stop.blocked.map((ticket) => row("skipped", ticket, "blocked"))
      : []),
  ];

  return [
    ...(newer === undefined ? [] : [newer]),
    `ticket-runner ${version} run ${runId} · ${Math.round(durationMs / 60_000)}m · ${billedTo(credential, billing)}`,
    "",
    ...(rows.length === 0 ? ["  nothing to do"] : rows),
    "",
    lastLine(stop, credential),
    "",
  ].join("\n");
}

/**
 * What the header says the Run's Stages were billed to. An `--api-key` Run
 * adds its spend, ending `+` where a Stage on the key reported no figure, so it
 * is at least that much. A subscription Run adds no amount, since its figure
 * is an estimate at API prices and not money spent, only whether a Stage ran
 * on the plan's extra usage.
 */
function billedTo(credential: Credential, billing: Billing): string {
  const words = CREDENTIAL_WORDS[credential];
  if (credential === "api-key") {
    return `${words} · ${dollars(billing.spendUsd)}${billing.spendUnreported ? "+" : ""}`;
  }
  return billing.extraUsage ? `${words} · extra usage` : words;
}

/**
 * A Stage billed somewhere the Run did not choose, with its own figure where it
 * gave one, ending `+` where that is only part of its session's.
 */
function billedRow(stray: StrayStage): string {
  const cost =
    stray.costUsd === undefined
      ? ""
      : ` · ${dollars(stray.costUsd)}${stray.costIncomplete === true ? "+" : ""}`;
  return row("billed", stray.ticket, `${stray.stage} · apiKeySource ${stray.apiKeySource}${cost}`);
}

/** An amount of dollars as the Run summary prints one: `$12.34`. */
function dollars(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** The one line that says why the Run stopped. */
function lastLine(stop: RunStop, credential: Credential): string {
  switch (stop.reason) {
    case "rate-limited": {
      const limited = credential === "api-key" ? "API rate limited" : "Rate limited";
      return stop.resetsAt === undefined
        ? `${limited}.`
        : `${limited} · resets ${utcMinute(stop.resetsAt)}.`;
    }
    case "api-error":
      return "API failure.";
    case "out-of-budget":
      return "Out of API budget.";
    case "failing-base":
      return `Base branch \`${stop.baseBranch}\` fails \`${stop.command}\` at ${stop.commit.slice(0, 7)}.`;
    // What failed and what it said, because the human may have to act: an
    // authentication failure mends only with a key or a login.
    case "github":
    case "remote":
      return `${capitalised(RELEASE_WORDS[stop.reason])} · \`${stop.command}\` · ${stop.line}`;
    case "stopped":
      return `Stopped at ${clockTime(stop.at)} · ${holding(stop.busy)}.`;
    case "frontier":
      return stop.blocked.length === 0 ? "Frontier empty." : "Frontier blocked.";
  }
}

/** `words` opening a line. */
function capitalised(words: string): string {
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * The minute a Stop arrived, in UTC — the clock the run id on the first line of
 * the summary is already written in, so the two can be read against each other.
 */
function clockTime(at: string): string {
  return at.slice(11, 16);
}

/**
 * The date and minute a limit resets, in UTC like the Stop's clock time. The
 * date is kept because a weekly limit can reset days after the Run stopped.
 */
function utcMinute(at: string): string {
  return `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
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
function ticketRows(outcome: TicketOutcome, credential: Credential): string[] {
  return [
    ticketRow(outcome, credential),
    ...(outcome.outcome === "skipped" ? [] : outcome.notes.map(noteRow)),
  ];
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
    `${destination} · from #${origin} ${stage} · ${truncate(splitMessage(summary).line, NOTE_WIDTH)}`,
  );
}

/** What a `handed` row says of a hand-off a fault outside the Ticket cut short. */
const CUT_SHORT = "hand-off cut short";

/** One Ticket's line in a summary: what happened to it, and where to look. */
function ticketRow(outcome: TicketOutcome, credential: Credential): string {
  switch (outcome.outcome) {
    case "merged":
      return row("merged", outcome.ticket, `${outcome.title} (PR #${outcome.pullRequest})`);
    case "handed-off":
      return row(
        "handed",
        outcome.ticket,
        // The one line of an unexpected error; its output is the hand-off's.
        `${outcome.title} · ${outcome.stage} · ${splitMessage(outcome.failure).line}` +
          // A hand-off the fault cut short says so, since a human finishes it.
          (outcome.fault === undefined
            ? ""
            : ` · ${CUT_SHORT} · ${releaseWords(outcome.fault.side, credential)}`),
      );
    case "released":
      // Nothing for a human to do, so the row says only what stopped the Stage
      // and where, and leaves the rest to the Run that resumes the Ticket.
      return row(
        "released",
        outcome.ticket,
        `${outcome.title} · ${releaseWords(outcome.cause, credential)} at ${outcome.stage}`,
      );
    case "skipped":
      // The reason is the guard's own word for it, which is also the marker on
      // the warning comment the human is being pointed at.
      return row("skipped", outcome.ticket, outcome.reason);
  }
}

function row(verb: string, ticket: number, detail: string): string {
  return `  ${verb.padEnd(VERB_WIDTH)}#${ticket} ${detail}`;
}
