/**
 * The prompt each Stage is given. Headless mode expands `/plugin:skill` in the
 * prompt string, which is how the pipeline drives a user-invoked skill
 * (ADR-0002).
 */

import { CONVENTIONS_PATH } from "./conventions.js";
import type { FailureKind } from "./lifecycle.js";
import { STAGE_ENV_VAR } from "./stage-guard.js";
import { BRANCH_TITLE } from "./title.js";

/**
 * Appended to every Stage prompt, the fix Stage included, in every Target. The
 * mechanical guard in `stage-guard.ts` is a tripwire against a slip; this is
 * what covers intent. It holds wherever the Stage runs, so it names the
 * pipeline as the command that started the session and says nothing of the
 * checkout, which in any other Target is the Target's own.
 */
export const STAGE_BOUNDARY_GUIDANCE = `The \`ticket-runner\` command started this session, so running it is running yourself:

- Never run \`ticket-runner\` against this repository or GitHub.
- Never kill processes you did not start. A pattern kill such as \`pkill -f node\` takes down the Run you belong to.
- ${STAGE_ENV_VAR} is set in this shell and the pipeline's own CLI refuses to start while it is. That refusal is expected; do not work around it.`;

/**
 * Appended after {@link STAGE_BOUNDARY_GUIDANCE} only where the Target is the
 * pipeline's own repository, as the Run decided before its first Ticket. There
 * the checkout is the pipeline, so it has tests and fakes to exercise it with
 * and spellings of its commands that name no installed `ticket-runner`.
 */
export const SELF_HOSTING_GUIDANCE = `This checkout is the pipeline that started this session:

- Exercise the pipeline only through its tests and fakes. Never run it from this checkout either, by any spelling: \`npm run ticket-runner\`, \`npx tsx src/cli.ts\`.`;

/** What a Stage is told about the pipeline it runs under, in the Target it runs in. */
function stageBoundary(selfHosted: boolean): string {
  return selfHosted
    ? `${STAGE_BOUNDARY_GUIDANCE}\n\n${SELF_HOSTING_GUIDANCE}`
    : STAGE_BOUNDARY_GUIDANCE;
}

/**
 * How the two Stages that write code are told to finish. A session ends with its
 * turn and stops every background task it started, so a session that hands its
 * last commit to a test run it left in the background never makes that commit.
 * `uncommittedPaths` and `discardChanges` both leave gitignored files alone, so
 * a Stage told only to remove what no commit carries deletes the dependencies
 * it installed for nothing.
 */
const FINISH_GUIDANCE = `- Never end your turn while uncommitted work waits on a background task: the session ends with your turn and stops that task, and the work is never committed.
- Leave the worktree clean: commit your work and remove every untracked file that is not ignored and that no commit carries, test output included. The pipeline refuses a worktree holding changes no commit carries.
- Keep gitignored files, such as dependencies you installed. The pipeline does not count them against a clean worktree, and deleting them only leaves the next Stage to install them again.`;

/** The Check commands as a prompt names them. */
function checkList(checks: readonly string[]): string {
  return checks.map((command) => `\`${command}\``).join(", ");
}

/**
 * How the two Stages that write code are told about the Checks, where the
 * config names any; nothing where it names none.
 *
 * The pipeline runs them as soon as the Stage finishes, so a Stage that runs the
 * whole suite while it works, and again after each change, pays for runs the
 * pipeline is about to make anyway: in the logged Runs that was half of an
 * implement Stage's wall clock. One run after its last commit still catches a
 * failure before it spends the Fix budget. implement's comes after the review,
 * because the review changes code in nearly every Stage.
 */
function codeChecksLine(checks: readonly string[], afterReview: boolean): string {
  if (checks.length === 0) return "";
  const review = afterReview ? " That one run comes after the review's fixes are committed." : "";
  return `\n- The pipeline runs its Checks as soon as you finish: ${checkList(checks)}. While you work, run only the tests your change touches. Commit, then run the full Checks once, in the foreground, and commit whatever that run makes you change.${review}`;
}

/**
 * How the two Stages that write code are told to title the branch. The title is
 * an answer rather than a commit subject because a commit subject describes its
 * own commit, and a later Stage could not retitle a branch whose first commit
 * was already pushed without rewriting it.
 */
const titleGuidance = (base: string) =>
  `- Answer a \`title\` beside your Notes: ${BRANCH_TITLE}, in the \`<type>(<scope>): <summary>\` shape \`${CONVENTIONS_PATH}\` states and without the \`(#<n>)\`. It titles the pull request and the squash commit on \`${base}\`, so each commit subject describes only its own commit.`;

/**
 * Guidance appended to every implement Stage, working around known defects of
 * the `implement` skill in an unattended session.
 */
const implementGuidance = (
  base: string,
  checks: readonly string[],
) => `This session is unattended. Follow this guidance as well as the skill's own:

- Make an initial commit before running \`/mattpocock-skills:code-review\`, so the reviewed diff is not empty.
${titleGuidance(base)}
- The review the skill asks for is \`/mattpocock-skills:code-review\`. Invoke it by that full name: the short name also matches the CLI's own built-in review skill, which runs neither the Standards review nor the Spec review.
- Spawn its review sub-agents with \`run_in_background: false\` set explicitly, several in one message so they still run in parallel. Omitting \`run_in_background\` still runs them in the background, and you would then reach your answer before the review has come back.
- Do not answer the schema until the review has returned and the fixes you take from it are committed. An answer you have already given does not stop you committing: the pipeline waits for this session to exit before it reads the branch.
- A later answer replaces an earlier one, so if you answer again, repeat every Note you still stand by.${codeChecksLine(checks, true)}
${FINISH_GUIDANCE}
- Do not spawn nested review agents beyond what the skill itself does.
- Do not open pull requests and do not close the issue; the pipeline does both.
- Commit all of your work to the branch that is already checked out.`;

/**
 * Appended to the two Stages that write code, which are the two that meet
 * things this Ticket is not about. Nothing here changes what the Stage is for:
 * it is the channel that stops a finding becoming either scope creep or a lost
 * paragraph in a transcript.
 *
 * A defect the branch itself introduced is the exception, and is said first:
 * "another Ticket" alone left it unowned, and such Notes became bug issues
 * opened after the branch that caused them had merged.
 */
const notesGuidance = (
  base: string,
  standingNotes?: number,
) => `Notes for other Tickets: if you discover something that belongs to another Ticket, or to no Ticket yet, do not act on it here and do not widen this Ticket to cover it.

- A defect this branch introduced, one that behaves correctly on \`${base}\` and wrongly here, or one in code this branch added, belongs to this Ticket: fix it, and do not record it as a Note.
- Record anything else as a Note instead. Your structured output carries a \`notes\` list, and the pipeline posts each entry where a human will meet it.
${noteEntryGuidance(standingNotes)}`;

/**
 * The same channel, as the Stage that grades rather than writes reads it.
 *
 * The guidance above is written for a Stage that could have fixed what it found
 * and is told not to. verify could not: it is told to fix nothing in the first
 * place, and what it has instead of a commit is a Verdict with a slot per
 * Acceptance Criterion. So this says which findings that Verdict already
 * carries — every judgement of a criterion — and gives the rest the Notes list,
 * because a defect outside the criteria has no slot anywhere else.
 */
const verifyNotesGuidance = (standingNotes?: number) => `Notes for other Tickets: your Verdict grades this Ticket's Acceptance Criteria and nothing else, so anything you find beside them is lost unless you record it as a Note.

- What you make of a criterion belongs in the Verdict. A criterion you judge \`unmet\` or \`unverifiable\` is reported in its own slot with the evidence you gathered, and never in a Note as well.
- A defect the criteria do not cover is a Note. Your structured output carries a \`notes\` list beside the criteria, and the pipeline posts each entry where a human will meet it.
- A Note of yours carries the evidence that the defect is real in its \`evidence\` field, held to the standard you hold a criterion you judge \`unmet\` to. You have the branch and you can run it, so something you suspect but did not demonstrate is not a Note.
- Writing the Note is all you do about it: fix nothing, commit nothing, stage nothing, exactly as the rest of your brief says.
${noteEntryGuidance(standingNotes)}`;

/**
 * What a Note is and what one looks like, whichever Stage is writing one.
 * Written once, because a Stage reading a stale copy is the only place the drift
 * would show.
 *
 * The bar leads, because it is the line that decides whether there is a Note at
 * all. Scope alone — this belongs to another Ticket — was the whole of it once,
 * and it let a preference through beside a defect: triage then read asides at
 * the price of a Ticket each, and the Tickets that came out sent Stages back in
 * to write more.
 */
const noteEntryGuidance = (standingNotes?: number) => `- A Note is a defect — something that behaves wrongly or breaks. A preference of yours, a refactor you would enjoy and a test that would be nice to have are not Notes, however right you are about them.
- Set \`ticket\` to the issue number the Note belongs to, and leave it out when you are not sure which one: a Note with no number becomes a comment on the issue the pipeline gathers Notes for triage on, where a wrong number lands on somebody else's Ticket.
- Write each Note in its parts: \`summary\` is one short sentence naming the defect; \`evidence\` is where the defect is and what shows it is real, what you ran or read, what you expected and what came back; \`impact\` is what breaks, and for whom; \`next\` is the fix, or the decision a human has to take before anyone can fix it, and is left out when there is neither.
- Write every part as plain sentences. No checkboxes: they would read as Acceptance Criteria.
- Emit \`"notes": []\` when you found nothing. That is the ordinary case and costs you nothing.${standingLine(standingNotes)}`;

/**
 * Where the Notes with no Ticket have been gathered so far, when any have.
 *
 * The number alone, never what is on it: the prompt would otherwise grow with
 * the backlog, and the Stage can read the issue itself.
 *
 * What it is asked for is what the issue does not already record. A second
 * report of a condition already there earns its comment by changing what a
 * reader would do about it — the facets that become Acceptance Criteria are
 * exactly those, and another instance of the same thing is a duplicate however
 * differently it is worded. Written when one Stage wrote Notes, the rule
 * withheld only an exact repeat; three Stages later that is a duplicate mill.
 */
function standingLine(standingNotes?: number): string {
  if (standingNotes === undefined) return "";
  return `\n- Notes with no Ticket are gathered on #${standingNotes}. Read it first and take what it already records as recorded: write a second Note about a condition it names only when what you saw changes what a reader would do about it, and not when it is another instance of the same thing.`;
}

/**
 * The verify Stage's brief. It grades a commit the Checks have just passed, so
 * where the config names any it is told so and told not to run them again: in
 * the logged Runs re-running them was about two fifths of a verify Stage's wall
 * clock, spent proving what the pipeline had already proved.
 *
 * A criterion that collides with a documented decision or another criterion is
 * `unmet` with a human's decision as its evidence, rather than met on a
 * workaround: the fix Stage it buys is told to commit nothing for it, which is
 * what hands the question to a human.
 */
const verifyInstructions = (checks: readonly string[]) => `You are the verify Stage of an unattended pipeline. Your job is adversarial: try to prove each Acceptance Criterion is NOT met.

- Read the Ticket's Acceptance Criteria from its body and from its comments; the checkbox list may live in either.
- Work in the checked-out branch, which already contains the implementation.
- Attempt to falsify every criterion: run the code, run the tests that bear on it, and write throwaway tests where that is the only way to tell.${verifyChecksLine(checks)}
- Judge the code as it is. Do not fix anything, and never commit, stage or push. Scratch files are fine; the pipeline discards them.
- Mark a criterion \`unverifiable\` only when no evidence can be gathered, never as a substitute for looking.
- When a criterion cannot be met without overturning a documented decision or another criterion, mark it \`unmet\` and say in its evidence that a human decision is needed, naming what it collides with. A workaround that sidesteps the collision does not meet it.
- End by emitting the Verdict: one entry per criterion with its status and the evidence you actually gathered.`;

/** The Checks as the verify Stage is told about them: passed, and not its to run. */
function verifyChecksLine(checks: readonly string[]): string {
  if (checks.length === 0) return "";
  return `\n- The pipeline's Checks passed on this commit: ${checkList(checks)}. Do not re-run them: grade a criterion that asks only for them from that fact, and spend your turns on targeted tests and probes.`;
}

/**
 * The fix Stage's brief. Sent in for unmet criteria, it is told what to do when
 * one of them needs a human decision: commit nothing, which hands the Ticket to
 * a human with the criteria and their evidence. Left to itself it worked around
 * every such criterion it met, and the verify behind it passed the workaround.
 */
const fixInstructions = (
  base: string,
  kind: FailureKind,
  checks: readonly string[],
) => `You are the fix Stage of an unattended pipeline. The Ticket below is already implemented on the branch you are on, and one gate failed. You are what its fix budget bought, and the budget is spent: a second failure of any kind hands the Ticket to a human.

- Commit your fix on the branch you are on, in this worktree. Do not create a branch, do not open pull requests, and do not close the Ticket.
- Start from the evidence: reproduce the failure, find what actually causes it, and fix that rather than the symptom.
- Where the failure is an unmet Acceptance Criterion, add the regression test that would have caught it and commit it with the fix.${kind === "unmet-criteria" ? DESIGN_CONFLICT_LINE : ""}
- Stay inside this Ticket's Acceptance Criteria and the defects this branch introduced. Anything else you find belongs to another Ticket, not to this session; record it as a Note rather than mending it.${codeChecksLine(checks, false)}
${FINISH_GUIDANCE}
- Write commit subjects in the convention \`${CONVENTIONS_PATH}\` states. The pipeline re-runs the Checks and the verify Stage as soon as you finish.
${titleGuidance(base)}`;

/** What the fix Stage sent in for unmet criteria does with one only a human can settle. */
const DESIGN_CONFLICT_LINE = `
- When any unmet criterion cannot be met without overturning a documented decision or another criterion, as the verify Stage's evidence may already say, commit nothing and say why in your last message. Do not work around it: a fix Stage that commits nothing hands the Ticket to a human, with the unmet criteria and their evidence.`;

/**
 * The conflict Stage's brief. It may reach past the conflicted files only to
 * repair what the merge broke there, such as a name the Base branch renamed:
 * a Stage that left those red would spend the Fix budget on them. Nothing it
 * does may change behaviour the criteria cover, because verify does not run
 * again after it.
 */
const conflictInstructions = (
  base: string,
  checks: readonly string[],
) => `You are the conflict Stage of an unattended pipeline. The Ticket below is already implemented on the branch you are on, and rebasing it onto \`${base}\` stopped on a conflict. That rebase is still in progress in this worktree, and finishing it is the whole of your job.

- Resolve every hunk and carry the rebase through to the end; never \`git rebase --abort\`, and never rewind the branch to escape the conflict.
- Where the two sides are compatible, keep both intents. Where they are not, keep the behaviour this Ticket's Acceptance Criteria ask for, and keep \`${base}\`'s everywhere the Ticket is silent.
- Resolve, do not redesign. Change a file the conflict did not touch only to repair what the merge itself broke, such as a renamed name or a moved field. Implement nothing new, and change no behaviour this Ticket's Acceptance Criteria cover: verify does not grade the branch again after you.
- Leave no conflict marker behind in any file, committed or not.
- Do not push, do not open pull requests, and do not close the Ticket.${conflictChecksLine(checks)}`;

/** The Checks as the conflict Stage is told about them: the pipeline's to run in full. */
function conflictChecksLine(checks: readonly string[]): string {
  if (checks.length === 0) return "";
  return `\n- The pipeline runs its Checks as soon as you finish, and a failure there spends this Ticket's fix budget: ${checkList(checks)}. Run the type checker and the tests covering the files you resolved, not the whole suite.`;
}

/** How the fix prompt announces each kind of failure. */
const failureSentences = (base: string): Record<FailureKind, string> => ({
  "uncommitted-work":
    "the Stage before you left changes in this worktree it never committed, listed below; commit what belongs to this Ticket and discard the rest",
  "failed-check": "a Check the pipeline runs itself failed",
  "unmet-criteria": "the verify Stage found unmet Acceptance Criteria",
  "failed-ci": "a pull request check failed after the branch was pushed",
  "unresolved-conflict": `the branch conflicts with ${base}, and the session sent in to resolve the rebase did not finish it`,
});

/** What went wrong, in the words the hand-off comment would have used. */
export interface FixFailure {
  kind: FailureKind;
  /** The one line a human would have read in a notification. */
  summary: string;
  /** Failing Check output, the unmet criteria with their evidence, or a CI excerpt. */
  evidence: string;
}

/** `/mattpocock-skills:implement <url>`, then the corrections, then config. */
export function implementPrompt(
  issueUrl: string,
  base: string,
  extraPrompt: string,
  selfHosted: boolean,
  checks: readonly string[],
  standingNotes?: number,
): string {
  return sections([
    `/mattpocock-skills:implement ${issueUrl}`,
    implementGuidance(base, checks),
    stageBoundary(selfHosted),
    notesGuidance(base, standingNotes),
    extraPrompt,
  ]);
}

/**
 * A fresh session with no plugin skill, graded against the Verdict schema.
 *
 * `unmetBefore` is the evidence of the Verdict a fix Stage was sent in for, in
 * the same Run; a first verify has none. Without it the verify behind a fix
 * graded the fix on its own terms, and passed a caveat the first one had
 * counted as unmet.
 */
export function verifyPrompt(
  issueUrl: string,
  extraPrompt: string,
  selfHosted: boolean,
  checks: readonly string[],
  standingNotes?: number,
  unmetBefore?: string,
): string {
  return sections([
    `Ticket: ${issueUrl}`,
    verifyInstructions(checks),
    unmetBefore === undefined ? "" : unmetBeforeSection(unmetBefore),
    stageBoundary(selfHosted),
    verifyNotesGuidance(standingNotes),
    extraPrompt,
  ]);
}

/** A fresh session with no plugin skill, given the conflict git reported. */
export function conflictPrompt(
  issueUrl: string,
  conflict: string,
  base: string,
  extraPrompt: string,
  selfHosted: boolean,
  checks: readonly string[],
): string {
  return sections([
    `Ticket: ${issueUrl}`,
    conflictInstructions(base, checks),
    outputSection("## Where the rebase stopped", conflict),
    stageBoundary(selfHosted),
    extraPrompt,
  ]);
}

/** A fresh session with no plugin skill, given one failure and told to mend it. */
export function fixPrompt(
  issueUrl: string,
  failure: FixFailure,
  base: string,
  extraPrompt: string,
  selfHosted: boolean,
  checks: readonly string[],
  standingNotes?: number,
): string {
  return sections([
    `Ticket: ${issueUrl}`,
    fixInstructions(base, failure.kind, checks),
    failureSection(failure, base),
    stageBoundary(selfHosted),
    notesGuidance(base, standingNotes),
    extraPrompt,
  ]);
}

/** The failure, its kind and its evidence, under a heading naming the kind. */
function failureSection({ kind, summary, evidence }: FixFailure, base: string): string {
  return outputSection(
    `## The failure: ${failureSentences(base)[kind]}`,
    evidence,
    summary,
  );
}

/** The unmet criteria a fix Stage was sent in for, and what meeting them now takes. */
function unmetBeforeSection(evidence: string): string {
  return outputSection(
    "## Judged unmet before the fix",
    evidence,
    "The verify Stage before you judged these criteria unmet, with this evidence, and a fix Stage has worked on the branch since. Such a criterion is met only when that counterexample is gone and the whole criterion holds: a fix that answers the evidence but not the rest of the criterion, or a caveat in place of the behaviour, leaves it `unmet`.",
  );
}

/**
 * A heading, an optional line of prose, and raw command output. The output is
 * fenced because it would otherwise be read as Markdown.
 */
function outputSection(heading: string, output: string, prose = ""): string {
  const trimmed = output.trim();
  return [
    heading,
    ...(prose === "" ? [] : ["", prose]),
    ...(trimmed === "" ? [] : ["", "```", trimmed, "```"]),
  ].join("\n");
}

function sections(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n\n");
}
