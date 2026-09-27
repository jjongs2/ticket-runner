/**
 * The prompt each Stage is given. Headless mode expands `/plugin:skill` in the
 * prompt string, which is how the pipeline drives a user-invoked skill
 * (ADR-0002).
 */

import { CONVENTIONS_PATH } from "./conventions.js";
import type { FailureKind } from "./lifecycle.js";
import { STAGE_ENV_VAR } from "./stage-guard.js";

/**
 * Appended to every Stage prompt, the fix Stage included. The mechanical guard
 * in `stage-guard.ts` is a tripwire against a slip; this is what covers intent.
 */
export const SELF_HOSTING_GUIDANCE = `This checkout is the pipeline that started this session, so running it is running yourself:

- Exercise the pipeline only through its tests and fakes. Never run its commands against this repository or GitHub, by any spelling: \`ticket-runner\`, \`npm run ticket-runner\`, \`npx tsx src/cli.ts\`.
- Never kill processes you did not start. A pattern kill such as \`pkill -f tsx\` takes down the Run you belong to.
- ${STAGE_ENV_VAR} is set in this shell and the pipeline's own CLI refuses to start while it is. That refusal is expected; do not work around it.`;

/**
 * How the two Stages that write code are told to finish. A session ends with its
 * turn and stops every background task it started, so a session that hands its
 * last commit to a test run it left in the background never makes that commit.
 * `uncommittedPaths` and `discardChanges` both leave gitignored files alone, so
 * a Stage told only to remove what no commit carries deletes the dependencies
 * it installed for nothing.
 */
const FINISH_GUIDANCE = `- Never end your turn while uncommitted work waits on a background task: the session ends with your turn and stops that task, and the work is never committed. Run your final tests in the foreground, then commit.
- Leave the worktree clean: commit your work and remove every untracked file that is not ignored and that no commit carries, test output included. The pipeline refuses a worktree holding changes no commit carries.
- Keep gitignored files, such as dependencies you installed. The pipeline does not count them against a clean worktree, and deleting them only leaves the next Stage to install them again.`;

/**
 * How the two Stages that write code are told to title the branch. The title is
 * an answer rather than a commit subject because a commit subject describes its
 * own commit, and a later Stage could not retitle a branch whose first commit
 * was already pushed without rewriting it.
 */
const titleGuidance = (base: string) =>
  `- Answer a \`title\` beside your Notes: one line summarising the whole branch as it stands when you finish, the work of any Stage before you included, in the \`<type>(<scope>): <summary>\` shape \`${CONVENTIONS_PATH}\` states and without the \`(#<n>)\`. It titles the pull request and the squash commit on \`${base}\`, so each commit subject describes only its own commit.`;

/**
 * Guidance appended to every implement Stage, working around known defects of
 * the `implement` skill in an unattended session.
 */
const implementGuidance = (base: string) => `This session is unattended. Follow this guidance as well as the skill's own:

- Confirm the Ticket title matches what you are about to build before you start.
- Make an initial commit before running \`/mattpocock-skills:code-review\`, so the reviewed diff is not empty.
${titleGuidance(base)}
- The review the skill asks for is \`/mattpocock-skills:code-review\`. Invoke it by that full name: the short name also matches the CLI's own built-in review skill, which runs neither the Standards review nor the Spec review.
- Spawn its review sub-agents with \`run_in_background: false\` set explicitly, several in one message so they still run in parallel. Omitting \`run_in_background\` still runs them in the background, and you would then reach your answer before the review has come back.
- Do not answer the schema until the review has returned and the fixes you take from it are committed. An answer you have already given does not stop you committing: the pipeline waits for this session to exit before it reads the branch.
- A later answer replaces an earlier one, so if you answer again, repeat every Note you still stand by.
${FINISH_GUIDANCE}
- Do not spawn nested review agents beyond what the skill itself does.
- Do not open pull requests and do not close the issue; the pipeline does both.
- Commit all of your work to the branch that is already checked out.`;

/**
 * Appended to the two Stages that write code, which are the two that meet
 * things this Ticket is not about. Nothing here changes what the Stage is for:
 * it is the channel that stops a finding becoming either scope creep or a lost
 * paragraph in a transcript.
 */
const notesGuidance = (standingNotes?: number) => `Notes for other Tickets: if you discover something that belongs to another Ticket, or to no Ticket yet, do not act on it here and do not widen this Ticket to cover it.

- Record it as a Note instead. Your structured output carries a \`notes\` list, and the pipeline posts each entry where a human will meet it.
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

const VERIFY_INSTRUCTIONS = `You are the verify Stage of an unattended pipeline. Your job is adversarial: try to prove each Acceptance Criterion is NOT met.

- Read the Ticket's Acceptance Criteria from its body and from its comments; the checkbox list may live in either.
- Work in the checked-out branch, which already contains the implementation.
- Attempt to falsify every criterion: run the code, run the tests, and write throwaway tests where that is the only way to tell.
- Judge the code as it is. Do not fix anything, and never commit, stage or push. Scratch files are fine; the pipeline discards them.
- Mark a criterion \`unverifiable\` only when no evidence can be gathered, never as a substitute for looking.
- End by emitting the Verdict: one entry per criterion with its status and the evidence you actually gathered.`;

const fixInstructions = (base: string) => `You are the fix Stage of an unattended pipeline. The Ticket below is already implemented on the branch you are on, and one gate failed. You are what its fix budget bought, and the budget is spent: a second failure of any kind hands the Ticket to a human.

- Commit your fix on the branch you are on, in this worktree. Do not create a branch, do not open pull requests, and do not close the Ticket.
- Start from the evidence: reproduce the failure, find what actually causes it, and fix that rather than the symptom.
- Where the failure is an unmet Acceptance Criterion, add the regression test that would have caught it and commit it with the fix.
- Stay inside this Ticket's Acceptance Criteria. Anything else you find belongs to another Ticket, not to this session; record it as a Note rather than mending it.
${FINISH_GUIDANCE}
- Write commit subjects in the convention \`${CONVENTIONS_PATH}\` states. The pipeline re-runs the Checks and the verify Stage as soon as you finish.
${titleGuidance(base)}`;

const conflictInstructions = (base: string) => `You are the conflict Stage of an unattended pipeline. The Ticket below is already implemented on the branch you are on, and rebasing it onto \`${base}\` stopped on a conflict. That rebase is still in progress in this worktree, and finishing it is the whole of your job.

- Follow the skill. Resolve every hunk and carry the rebase through to the end; never \`git rebase --abort\`, and never rewind the branch to escape the conflict.
- Where the two sides are compatible, keep both intents. Where they are not, keep the behaviour this Ticket's Acceptance Criteria ask for, and keep \`${base}\`'s everywhere the Ticket is silent.
- Resolve, do not redesign. Implement nothing new, and touch no file the conflict did not.
- Leave no conflict marker behind in any file, committed or not.
- Do not push, do not open pull requests, and do not close the Ticket. The pipeline runs the Checks again as soon as you finish, and a failure there spends this Ticket's fix budget.`;

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
  standingNotes?: number,
): string {
  return sections([
    `/mattpocock-skills:implement ${issueUrl}`,
    implementGuidance(base),
    SELF_HOSTING_GUIDANCE,
    notesGuidance(standingNotes),
    extraPrompt,
  ]);
}

/** A fresh session with no plugin skill, graded against the Verdict schema. */
export function verifyPrompt(
  issueUrl: string,
  extraPrompt: string,
  standingNotes?: number,
): string {
  return sections([
    `Ticket: ${issueUrl}`,
    VERIFY_INSTRUCTIONS,
    SELF_HOSTING_GUIDANCE,
    verifyNotesGuidance(standingNotes),
    extraPrompt,
  ]);
}

/** `/mattpocock-skills:resolving-merge-conflicts`, then the conflict git reported. */
export function conflictPrompt(
  issueUrl: string,
  conflict: string,
  base: string,
  extraPrompt: string,
): string {
  return sections([
    "/mattpocock-skills:resolving-merge-conflicts",
    `Ticket: ${issueUrl}`,
    conflictInstructions(base),
    outputSection("## Where the rebase stopped", conflict),
    SELF_HOSTING_GUIDANCE,
    extraPrompt,
  ]);
}

/** A fresh session with no plugin skill, given one failure and told to mend it. */
export function fixPrompt(
  issueUrl: string,
  failure: FixFailure,
  base: string,
  extraPrompt: string,
  standingNotes?: number,
): string {
  return sections([
    `Ticket: ${issueUrl}`,
    fixInstructions(base),
    failureSection(failure, base),
    SELF_HOSTING_GUIDANCE,
    notesGuidance(standingNotes),
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
