/**
 * The prompt each Stage is given. Headless mode expands `/plugin:skill` in the
 * prompt string, which is how the pipeline drives a user-invoked skill
 * (ADR-0002).
 */

import type { FailureKind } from "./lifecycle.js";
import { STAGE_ENV_VAR } from "./stage-guard.js";

/**
 * Appended to every Stage prompt, the fix Stage included. The mechanical guard
 * in `stage-guard.ts` is a tripwire against a slip; this is what covers intent.
 */
export const SELF_HOSTING_GUIDANCE = `This checkout is the pipeline that started this session, so running it is running yourself:

- Exercise the pipeline only through its tests and fakes. Never run its commands against this repository or GitHub, by any spelling: \`agent-pipeline\`, \`npm run agent-pipeline\`, \`npx tsx src/cli.ts\`.
- Never kill processes you did not start. A pattern kill such as \`pkill -f tsx\` takes down the Run you belong to.
- ${STAGE_ENV_VAR} is set in this shell and the pipeline's own CLI refuses to start while it is. That refusal is expected; do not work around it.`;

/**
 * Guidance appended to every implement Stage, working around known defects of
 * the `implement` skill in an unattended session.
 */
const IMPLEMENT_GUIDANCE = `This session is unattended. Follow this guidance as well as the skill's own:

- Confirm the Ticket title matches what you are about to build before you start.
- Make an initial commit before running code-review, so the reviewed diff is not empty.
- Your first commit's subject becomes the pull request title and the squash commit on \`main\`, so write it in the repo's commit convention and make it summarise the whole Ticket, not just that first commit.
- Do not spawn nested review agents beyond what the skill itself does.
- Do not open pull requests and do not close the issue; the pipeline does both.
- Commit all of your work to the branch that is already checked out.`;

const VERIFY_INSTRUCTIONS = `You are the verify Stage of an unattended pipeline. Your job is adversarial: try to prove each Acceptance Criterion is NOT met.

- Read the Ticket's Acceptance Criteria from its body and from its comments; the checkbox list may live in either.
- Work in the checked-out branch, which already contains the implementation.
- Attempt to falsify every criterion: run the code, run the tests, and write throwaway tests where that is the only way to tell.
- Judge the code as it is. Do not fix anything, and never commit, stage or push. Scratch files are fine; the pipeline discards them.
- Mark a criterion \`unverifiable\` only when no evidence can be gathered, never as a substitute for looking.
- End by emitting the Verdict: one entry per criterion with its status and the evidence you actually gathered.`;

const FIX_INSTRUCTIONS = `You are the fix Stage of an unattended pipeline. The Ticket below is already implemented on the branch you are on, and one gate failed. You are what its fix budget bought, and the budget is spent: a second failure of any kind hands the Ticket to a human.

- Commit your fix on the branch you are on, in this worktree. Do not create a branch, do not open pull requests, and do not close the Ticket.
- Start from the evidence: reproduce the failure, find what actually causes it, and fix that rather than the symptom.
- Where the failure is an unmet Acceptance Criterion, add the regression test that would have caught it and commit it with the fix.
- Stay inside this Ticket's Acceptance Criteria. Anything else you find belongs to another Ticket, not to this session.
- Write commit subjects in the repo's commit convention. The pipeline re-runs the Checks and the verify Stage as soon as you finish.`;

const CONFLICT_INSTRUCTIONS = `You are the conflict Stage of an unattended pipeline. The Ticket below is already implemented on the branch you are on, and rebasing it onto \`main\` stopped on a conflict. That rebase is still in progress in this worktree, and finishing it is the whole of your job.

- Follow the skill. Resolve every hunk and carry the rebase through to the end; never \`git rebase --abort\`, and never rewind the branch to escape the conflict.
- Where the two sides are compatible, keep both intents. Where they are not, keep the behaviour this Ticket's Acceptance Criteria ask for, and keep main's everywhere the Ticket is silent.
- Resolve, do not redesign. Implement nothing new, and touch no file the conflict did not.
- Leave no conflict marker behind in any file, committed or not.
- Do not push, do not open pull requests, and do not close the Ticket. The pipeline runs the Checks again as soon as you finish, and a failure there spends this Ticket's fix budget.`;

/** How the fix prompt announces each kind of failure. */
const FAILURE_SENTENCES: Record<FailureKind, string> = {
  "failed-check": "a Check the pipeline runs itself failed",
  "unmet-criteria": "the verify Stage found unmet Acceptance Criteria",
  "failed-ci": "a pull request check failed after the branch was pushed",
  "unresolved-conflict":
    "the branch conflicts with main, and the session sent in to resolve the rebase did not finish it",
};

/** What went wrong, in the words the hand-off comment would have used. */
export interface FixFailure {
  kind: FailureKind;
  /** The one line a human would have read in a notification. */
  summary: string;
  /** Failing Check output, the unmet criteria with their evidence, or a CI excerpt. */
  evidence: string;
}

/** `/mattpocock-skills:implement <url>`, then the corrections, then config. */
export function implementPrompt(issueUrl: string, extraPrompt: string): string {
  return sections([
    `/mattpocock-skills:implement ${issueUrl}`,
    IMPLEMENT_GUIDANCE,
    SELF_HOSTING_GUIDANCE,
    extraPrompt,
  ]);
}

/** A fresh session with no plugin skill, graded against the Verdict schema. */
export function verifyPrompt(issueUrl: string, extraPrompt: string): string {
  return sections([
    `Ticket: ${issueUrl}`,
    VERIFY_INSTRUCTIONS,
    SELF_HOSTING_GUIDANCE,
    extraPrompt,
  ]);
}

/** `/mattpocock-skills:resolving-merge-conflicts`, then the conflict git reported. */
export function conflictPrompt(
  issueUrl: string,
  conflict: string,
  extraPrompt: string,
): string {
  return sections([
    "/mattpocock-skills:resolving-merge-conflicts",
    `Ticket: ${issueUrl}`,
    CONFLICT_INSTRUCTIONS,
    fenced("## Where the rebase stopped", conflict),
    SELF_HOSTING_GUIDANCE,
    extraPrompt,
  ]);
}

/** A fresh session with no plugin skill, given one failure and told to mend it. */
export function fixPrompt(
  issueUrl: string,
  failure: FixFailure,
  extraPrompt: string,
): string {
  return sections([
    `Ticket: ${issueUrl}`,
    FIX_INSTRUCTIONS,
    failureSection(failure),
    SELF_HOSTING_GUIDANCE,
    extraPrompt,
  ]);
}

/** The failure, its kind and its evidence, under a heading naming the kind. */
function failureSection({ kind, summary, evidence }: FixFailure): string {
  return fenced(`## The failure: ${FAILURE_SENTENCES[kind]}`, evidence, summary);
}

/**
 * A heading, an optional line of prose, and raw command output. The output is
 * fenced because it would otherwise be read as Markdown.
 */
function fenced(heading: string, output: string, prose = ""): string {
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
