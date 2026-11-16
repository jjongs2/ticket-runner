/**
 * The prompt each Stage is given. Headless mode expands `/plugin:skill` in the
 * prompt string, which is how the pipeline drives a user-invoked skill
 * (ADR-0002).
 */

import type { ListedCriterion } from "./acceptance-criteria.js";
import type { FailureKind } from "./lifecycle.js";
import { BRANCH_DEFECT, OWN_DEFECT } from "./note-schema.js";
import { NOTE_PARTS, type WrittenNote } from "./notes.js";
import { STAGE_ENV_VAR } from "./stage-guard.js";
import { BRANCH_ANSWER_FIELDS, BRANCH_TITLE, type BranchAnswers, SUBJECT_RULE } from "./title.js";

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

/**
 * What every Stage that commits is told about branches, in one sentence: the
 * pipeline pushes the branch it checked out, so work on any other is lost.
 */
const NO_OTHER_BRANCH = "Do not create a branch, and do not switch to another.";

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
 * failure before it spends the fix budget. implement's comes after the review,
 * because the review changes code in nearly every Stage.
 */
function codeChecksLine(checks: readonly string[], afterReview: boolean): string {
  if (checks.length === 0) return "";
  const review = afterReview ? " That one run comes after the review's fixes are committed." : "";
  return `\n- The pipeline runs its Checks as soon as you finish: ${checkList(checks)}. While you work, run only the tests your change touches. Commit, then run the full Checks once, in the foreground, and commit whatever that run makes you change.${review}`;
}

/** The title a code Stage answers, what it is and what it is for, wherever it is told to answer one. */
const titleAnswer = (base: string) =>
  `a \`title\` beside your Notes: ${BRANCH_TITLE}, ${SUBJECT_RULE}, and without the \`(#<n>)\`. It titles the pull request and the squash commit on \`${base}\`, so each commit subject describes only its own commit.`;

/**
 * How the implement Stage is told to title the branch. The title is an answer
 * rather than a commit subject because a commit subject describes its own
 * commit, and a later Stage could not retitle a branch whose first commit was
 * already pushed without rewriting it.
 */
const titleGuidance = (base: string) => `- Answer ${titleAnswer(base)}`;

/**
 * How the fix Stage is told to title the branch: blank, which keeps the title
 * answered before it, unless its fix changes what that title says. Told to
 * answer one for the whole branch, a fix Stage that had not read the Target's
 * rules replaced a title its fix left true with one that broke them (#334).
 */
const fixTitleGuidance = (base: string) =>
  `- The \`title\` answered for this branch so far is below, when there is one. Answer \`title\` as an empty string, which keeps it, unless your fix changes what it says. When it does, or when none is below, answer ${titleAnswer(base)}`;

/**
 * Where the pull request body's shape comes from. A Target's own rules come
 * first: a Stage reads its instructions anyway, so ignoring them would leave it
 * two conflicting orders. The `pr` skill is named by its full name, because a
 * short name may match a skill of the Target's own.
 */
const BODY_SHAPE =
  "in the shape this repository's contributing guide or its `.github/PULL_REQUEST_TEMPLATE.md` sets, when either sets a pull request body's sections or content beyond the `Closes` line; where neither does, invoke `/mattpocock-skills:pr` by that full name and write it in that skill's shape";

/**
 * How the problem and the solution read. The shape is stated here rather than
 * pointed at, because the skill it comes from is a personal one, not part of
 * the plugin a Target installs.
 */
const PROSE_SHAPE =
  "as this repository's contributing guide sets a commit body, when it does; where it does not, the problem is the state before the change and its effect, and the solution is what the change does and why, each in at most two sentences, readable without opening the Ticket, leaving out what the diff and the body already show, such as side changes and individual names";

/**
 * What none of the three may carry. They are published on the Target's
 * repository, and the pipeline writes the one `Closes #<n>` itself, so a
 * second closing keyword could close an issue nobody meant to.
 */
const PROSE_LIMITS =
  "None of the three carries a title, a closing keyword (`Closes`, `Fixes`, `Resolves`) before an issue reference, a screenshot or a local path: they are published on this repository, and the pipeline writes the one `Closes #<n>` itself.";

/**
 * How the implement Stage is told to answer the body, the problem and the
 * solution: once, for the whole branch, after the review that changes it.
 */
const PROSE_GUIDANCE = `- Once the review's fixes are committed, answer a \`body\`, a \`problem\` and a \`solution\` beside \`title\`, each written for the whole branch. The \`body\` is the pull request's body below the \`Closes #<n>\` line the pipeline writes: write it ${BODY_SHAPE}. The \`problem\` and the \`solution\` open the squash commit's body, so \`git log\` says why without the Ticket: write them ${PROSE_SHAPE}. ${PROSE_LIMITS}`;

/**
 * The language a Stage writes its answers in. A Stage left to itself wrote
 * English on a Target whose issues and commits are in another language. The
 * criterion's text is the exception: it is the Ticket's, quoted.
 */
const languageLine = (answers: string) =>
  `- Write ${answers} in the language this repository's contributing guide sets for issues and commits, and where it sets none, in the language the Ticket is written in. A criterion's text stays as the Ticket writes it.`;

/** What the two Stages that write code answer in the Target's language. */
const CODE_STAGE_LANGUAGE = languageLine(
  "your Notes, `title`, `body`, `problem`, `solution` and `noCommitReason`",
);

/**
 * Guidance appended to every implement Stage, working around known defects of
 * the `implement` skill in an unattended session.
 *
 * The Ticket's URL is handed to the review explicitly: the review looks for its
 * spec in the commit messages first, the skill does not always pass it on, and
 * commit subjects need not carry the Ticket number.
 */
const implementGuidance = (
  issueUrl: string,
  base: string,
  checks: readonly string[],
) => `This session is unattended. Follow this guidance as well as the skill's own:

- Make an initial commit before running \`/mattpocock-skills:code-review\`, so the reviewed diff is not empty.
${titleGuidance(base)}
${PROSE_GUIDANCE}
${CODE_STAGE_LANGUAGE}
- The review the skill asks for is \`/mattpocock-skills:code-review\`. Invoke it by that full name: the short name also matches the CLI's own built-in review skill, which runs neither the Standards review nor the Spec review.
- Pass the review this Ticket's URL, \`${issueUrl}\`, as the spec. It otherwise looks for the spec in the commit messages, which need not name the Ticket, and reviews with no spec without saying so.
- Spawn its review sub-agents with \`run_in_background: false\` set explicitly, several in one message so they still run in parallel. Omitting \`run_in_background\` still runs them in the background, and you would then reach your answer before the review has come back.
- Do not answer the schema until the review has returned and the fixes you take from it are committed. An answer you have already given does not stop you committing: the pipeline waits for this session to exit before it reads the branch.
- A later answer replaces an earlier one, so if you answer again, repeat every Note you still stand by.${codeChecksLine(checks, true)}
${FINISH_GUIDANCE}
- Do not spawn nested review agents beyond what the skill itself does.
- Do not open pull requests and do not close the issue; the pipeline does both.
- Commit all of your work to the branch that is already checked out. ${NO_OTHER_BRANCH}`;

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
const notesGuidance = (standingNotes?: number) => `Notes for other Tickets: if you discover something that belongs to another Ticket, or to no Ticket yet, do not act on it here and do not widen this Ticket to cover it.

- ${OWN_DEFECT}: fix it, and do not record it as a Note.
- Record anything else as a Note instead. Your structured output carries a \`notes\` list, and the pipeline posts each entry where a human will meet it.
${noteEntryGuidance(standingNotes)}`;

/**
 * The same channel, as the Stage that grades rather than writes reads it.
 *
 * The guidance above is written for a Stage that could have fixed what it found
 * and is told not to. verify could not: it is told to fix nothing in the first
 * place, and what it has instead of a commit is a verdict with a slot per
 * Acceptance Criterion and a list of the defects the branch made. So this says
 * which findings that verdict already carries and gives the rest the Notes
 * list, because a defect that is not the branch's has no slot anywhere else.
 */
const verifyNotesGuidance = (standingNotes?: number) => `Notes for other Tickets: your verdict carries what you make of each criterion and every defect this branch made, so anything else you find is lost unless you record it as a Note.

- What you make of a criterion belongs in the verdict. A criterion you judge \`unmet\` or \`unverifiable\` is reported in its own slot with the evidence you gathered, and never in a Note as well.
- A defect this branch made belongs in the verdict's \`defects\`, never in a Note, and so does one among the Notes this Ticket's implement and fix Stages wrote.
- Any other defect is a Note. Your structured output carries a \`notes\` list beside the criteria, and the pipeline posts each entry where a human will meet it.
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
- What this Ticket's own deliverable already records is not a Note either, such as a finding in the report section the Ticket asks for.
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
 * What makes an unmet criterion one only a human can settle, in the words both
 * the verify and the fix Stage are given.
 */
const NEEDS_A_HUMAN =
  "cannot be met without overturning a documented decision or another criterion";

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
 *
 * An `unmet` criterion's evidence states the failure and proposes no fix. The
 * fix Stage reads that evidence first, and in #292 it implemented the patch a
 * verify had proposed word for word and tested only that verify's
 * counterexample; the next verify broke the patch with the next input, while a
 * fix of the cause was open within the Ticket's limit all along. A limit the
 * evidence quotes is still the fix Stage's to know, so it may stay.
 *
 * The criteria are listed by the pipeline and answered by number, so the
 * verdict never has to copy a criterion for anything to find it again.
 *
 * A defect the branch itself made is graded here too, beside the criteria,
 * and fails the verdict as an unmet criterion does. Sent to a Note instead, it
 * merged with the branch that made it, and triage opened a bug Ticket for it
 * within hours.
 */
const verifyInstructions = (checks: readonly string[]) => `You are the verify Stage of an unattended pipeline. Your job is adversarial: try to prove each Acceptance Criterion is NOT met, and find the defects this branch made.

- The pipeline lists the Ticket's Acceptance Criteria below, numbered, each with the indented lines under its checkbox. Read the Ticket for their context, and grade the criteria as listed: answer each by its number, every listed number once and no other.
- Work in the checked-out branch, which already contains the implementation.
- Attempt to falsify every criterion: run the code, run the tests that bear on it, and write throwaway tests where that is the only way to tell.${verifyChecksLine(checks)}
- Judge the code as it is. Do not fix anything, and never commit, stage or push. Scratch files are fine; the pipeline discards them.
- Mark a criterion \`unverifiable\` only when no evidence can be gathered, never as a substitute for looking.
- When a criterion ${NEEDS_A_HUMAN}, mark it \`unmet\` and say in its evidence that a human decision is needed, naming what it collides with. A workaround that sidesteps the collision does not meet it.
- ${BRANCH_DEFECT}, is reported in the verdict's \`defects\`, beside the criteria and not as a Note, when you show it with the evidence an \`unmet\` criterion needs, unless the Ticket leaves it out of scope or a documented decision accepts it. It fails the verdict as an \`unmet\` criterion does, and its evidence follows the same rule.
- An \`unmet\` criterion's evidence states the failure: where it sits, what you ran or read, what you expected, what came back, and the counterexample. It proposes no fix and no direction for one, and neither does what you say about whether a human decision is needed. It may quote a limit the Ticket, a documented decision or another criterion sets, naming where it comes from. A fix written there is what the fix Stage behind you would implement in place of finding the cause. This holds for a criterion's evidence only: a Note's \`next\` still carries the fix.
- End by emitting the verdict: one entry per listed criterion, by its number, with its status and the evidence you actually gathered, and one entry in \`defects\` per defect of this branch you showed.
${languageLine("your Notes and the verdict's evidence")}`;

/** The Checks as the verify Stage is told about them: passed, and not its to run. */
function verifyChecksLine(checks: readonly string[]): string {
  if (checks.length === 0) return "";
  return `\n- The pipeline's Checks passed on this commit: ${checkList(checks)}. Do not re-run them: grade a criterion that asks only for them from that fact, and spend your turns on targeted tests and probes.`;
}

/**
 * The fix Stage's brief. Sent in for unmet criteria, it is told what to do when
 * one of them needs a human decision: commit nothing and say why in
 * `noCommitReason`, which hands the Ticket to a human with the criteria, their
 * evidence and that reason. Left to itself it worked around
 * every such criterion it met, and the verify behind it passed the workaround.
 *
 * It is also told to fix the cause the evidence points at, not the patch the
 * evidence may still propose, and to test that fix the way the next verify will
 * attack it, for the reason {@link verifyInstructions} gives.
 *
 * It drives no plugin skill but the `pr` skill: the implement skill would
 * re-read the Ticket and start over.
 */
const fixInstructions = (
  base: string,
  kind: FailureKind,
  checks: readonly string[],
) => `You are the fix Stage of an unattended pipeline. The Ticket below is already implemented on the branch you are on, and one gate failed. You are what its fix budget bought, and the budget is spent: a second failure of any kind hands the Ticket to a human.

- Commit your fix on the branch you are on, in this worktree. ${NO_OTHER_BRANCH} Do not open pull requests, and do not close the Ticket.
- Start from the evidence: reproduce the failure, find what actually causes it, and fix that rather than the symptom.
- Where the failure is an unmet Acceptance Criterion or a defect this branch made, add the regression test that would have caught it and commit it with the fix.${kind === "unmet-criteria" ? `${UNMET_CAUSE_LINES}${HUMAN_DECISION_LINE}` : ""}
- Stay inside this Ticket's Acceptance Criteria and the defects this branch introduced. Anything else you find belongs to another Ticket, not to this session; record it as a Note rather than mending it.${codeChecksLine(checks, false)}
${FINISH_GUIDANCE}
- Write commit subjects ${SUBJECT_RULE}. The pipeline re-runs the Checks and the verify Stage as soon as you finish.
${fixTitleGuidance(base)}
${FIX_PROSE_GUIDANCE}
${CODE_STAGE_LANGUAGE}
- Invoke no plugin skill but \`/mattpocock-skills:pr\`: the implement skill would re-read the Ticket and start over.
${NO_COMMIT_LINE}`;

/**
 * How the fix Stage is told to answer the body, the problem and the solution:
 * revised for the whole branch where its fix changes what one says, so the
 * before an earlier Stage found is not lost, and blank otherwise, which keeps
 * the earlier one.
 */
const FIX_PROSE_GUIDANCE = `- The \`body\`, \`problem\` and \`solution\` answered for this branch so far are below, when there are any. When your fix changes what one of them says, answer that one revised for the whole branch, keeping whatever it says of the branch before your fix that still holds: the \`body\` ${BODY_SHAPE}; the \`problem\` and the \`solution\` ${PROSE_SHAPE}. Answer each one your fix leaves true as an empty string, which keeps it. ${PROSE_LIMITS}`;

/**
 * What every fix Stage is told about ending without a new commit, whatever it
 * was sent in for. Ending so hands the Ticket to a human, and the reason the
 * Stage answers is the one thing of what it said that reaches the hand-off:
 * under `--json-schema` a last message in prose stays in the transcript. The
 * implement Stage is not told this: its prompt names the field only among the
 * answers it writes in the Target's language, and the schema's description is
 * all it reads of what the field is for, so its prompt does not invite it to
 * end without committing.
 */
const NO_COMMIT_LINE =
  "- If you end without a new commit, say why in `noCommitReason`, in a few sentences: committing nothing hands the Ticket to a human, and the hand-off comment quotes your reason. Otherwise answer it empty.";

/** How the fix Stage sent in for unmet criteria reaches and tests a fix of the cause. */
const UNMET_CAUSE_LINES = `
- Look for a fix of the cause you found within the scope this Ticket sets before you settle for a narrower one, such as a patch that answers only the counterexample.
- Before you commit, test your fix with inputs built from the cause you found, of the kind a verify Stage trying to falsify the criterion would try, and not only with the counterexample you were given. Your regression test covers the cause, not only that counterexample.`;

/** What the fix Stage sent in for unmet criteria does with one only a human can settle. */
const HUMAN_DECISION_LINE = `
- When any unmet criterion ${NEEDS_A_HUMAN}, or any defect cannot be fixed without overturning one, as the verify Stage's evidence may already say, commit nothing and give your reason in \`noCommitReason\`: which criterion or defect, and what it collides with. Do not work around it: a fix Stage that commits nothing hands the Ticket to a human, with the unmet criteria, the defects, their evidence and your reason.`;

/**
 * The conflict Stage's brief. It may reach past the conflicted files only to
 * repair what the merge broke there, such as a name the base branch renamed:
 * a Stage that left those red would spend the fix budget on them. Nothing it
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
- ${NO_OTHER_BRANCH} Do not push, do not open pull requests, and do not close the Ticket.${conflictChecksLine(checks)}`;

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
  "unmet-criteria": "the verify Stage found unmet Acceptance Criteria, or defects this branch made",
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
    implementGuidance(issueUrl, base, checks),
    stageBoundary(selfHosted),
    notesGuidance(standingNotes),
    extraPrompt,
  ]);
}

/** What the verify Stage is given to grade beside the Ticket's URL. */
export interface VerifyBrief {
  /** The Ticket's unticked criteria, numbered, which the verdict answers by number. */
  criteria?: readonly ListedCriterion[];
  /** The Notes this Ticket's implement and fix Stages wrote in this Run. */
  written?: readonly WrittenNote[];
}

/**
 * A fresh session with no plugin skill, graded against the verdict schema.
 *
 * `unmetBefore` is the evidence of the verdict a fix Stage was sent in for, in
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
  { criteria = [], written = [] }: VerifyBrief = {},
): string {
  return sections([
    `Ticket: ${issueUrl}`,
    verifyInstructions(checks),
    criteriaSection(criteria),
    unmetBefore === undefined ? "" : unmetBeforeSection(unmetBefore),
    writtenNotesSection(written),
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

/**
 * A fresh session with no plugin skill but the `pr` skill, given one failure
 * and told to mend it, and the title, body, problem and solution answered so
 * far.
 */
export function fixPrompt(
  issueUrl: string,
  failure: FixFailure,
  base: string,
  extraPrompt: string,
  selfHosted: boolean,
  checks: readonly string[],
  standingNotes?: number,
  answers: BranchAnswers = {},
): string {
  return sections([
    `Ticket: ${issueUrl}`,
    fixInstructions(base, failure.kind, checks),
    failureSection(failure, base),
    answersSection(answers),
    stageBoundary(selfHosted),
    notesGuidance(standingNotes),
    extraPrompt,
  ]);
}

/**
 * The failure, its kind and its evidence, under a heading naming the kind. The
 * unmet criteria's evidence is a verify Stage's prose rather than output, and
 * may still propose a fix, so it is read as where to start looking.
 */
function failureSection({ kind, summary, evidence }: FixFailure, base: string): string {
  return outputSection(
    `## The failure: ${failureSentences(base)[kind]}`,
    evidence,
    kind === "unmet-criteria" ? `${summary}\n\n${UNMET_EVIDENCE_LEAD}` : summary,
  );
}

/** How the fix Stage reads the unmet criteria's evidence, said beside it. */
const UNMET_EVIDENCE_LEAD =
  "This is the verify Stage's evidence for each unmet criterion, given as its checkbox line reads, and for each defect this branch made. A fix this evidence proposes is a lead, not the answer: find the cause yourself, starting from the failure it states.";

/**
 * The title, the body, the problem and the solution answered for the branch so
 * far, each under its field's name; nothing where none has been answered.
 */
function answersSection(answers: BranchAnswers): string {
  const answered = BRANCH_ANSWER_FIELDS.flatMap((field) => {
    const answer = answers[field];
    return answer === undefined ? [] : [`### \`${field}\`\n\n${fenced(answer)}`];
  });
  if (answered.length === 0) return "";
  return ["## What the branch's answers say now", ...answered].join("\n\n");
}

/**
 * Text fenced with more backticks than any run inside it, so a body that
 * carries a fence of its own reads as one block.
 */
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** The unmet criteria and defects a fix Stage was sent in for, and what clearing them now takes. */
function unmetBeforeSection(evidence: string): string {
  return outputSection(
    "## Judged unmet before the fix",
    evidence,
    "The verify Stage before you judged these criteria unmet, and these defects the branch's own, with this evidence, and a fix Stage has worked on the branch since. Such a criterion is met only when that counterexample is gone and the whole criterion holds: a fix that answers the evidence but not the rest of the criterion, or a caveat in place of the behaviour, leaves it `unmet`. Such a defect goes in your `defects` again until its counterexample is gone.",
  );
}

/**
 * The criteria the verdict answers, by number, each with the lines under its
 * checkbox; fenced, because they are the Ticket's Markdown, quoted.
 */
function criteriaSection(criteria: readonly ListedCriterion[]): string {
  if (criteria.length === 0) return "";
  const listed = criteria.flatMap(({ number, text, details }) => [
    `${number}. ${text}`,
    ...indented(details),
  ]);
  return [
    "## The Acceptance Criteria, by number",
    "",
    "Each is an unticked checkbox on the Ticket, in the order the body and then its comments write them. A checkbox nested under another is a criterion of its own.",
    "",
    fenced(listed.join("\n")),
  ].join("\n");
}

/** Lines under a numbered criterion, their own indent kept relative to each other. */
function indented(lines: readonly string[]): string[] {
  const widths = lines
    .filter((line) => line.trim() !== "")
    .map((line) => (/^[ \t]*/.exec(line)?.[0] ?? "").length);
  const common = Math.min(...widths);
  return lines.map((line) => (line.trim() === "" ? "" : `   ${line.slice(common)}`));
}

/**
 * The Notes this Ticket's code Stages wrote in this Run, which the verify Stage
 * grades for a defect of the branch; nothing where they wrote none.
 */
function writtenNotesSection(written: readonly WrittenNote[]): string {
  if (written.length === 0) return "";
  const lines = written.flatMap(({ stage, note }) => [
    `- From the ${stage} Stage${note.ticket === undefined ? "" : `, for #${note.ticket}`}: ${note.summary}`,
    ...NOTE_PARTS.flatMap((part) => {
      const text = note[part];
      return text === undefined ? [] : [`  ${part}: ${text}`];
    }),
  ]);
  return [
    "## Notes this Ticket's implement and fix Stages wrote in this Run",
    "",
    "The pipeline has already posted these. One that is a defect this branch made is graded in your verdict's `defects`, held to the same evidence as one you found yourself.",
    "",
    fenced(lines.join("\n")),
  ].join("\n");
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
