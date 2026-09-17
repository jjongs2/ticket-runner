/**
 * The prompt each Stage is given. Headless mode expands `/plugin:skill` in the
 * prompt string, which is how the pipeline drives a user-invoked skill
 * (ADR-0002).
 */

/**
 * Guidance appended to every implement Stage, working around known defects of
 * the `implement` skill in an unattended session.
 */
const IMPLEMENT_GUIDANCE = `This session is unattended. Follow this guidance as well as the skill's own:

- Confirm the Ticket title matches what you are about to build before you start.
- Make an initial commit before running code-review, so the reviewed diff is not empty.
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

/** `/mattpocock-skills:implement <url>`, then the corrections, then config. */
export function implementPrompt(issueUrl: string, extraPrompt: string): string {
  return sections([
    `/mattpocock-skills:implement ${issueUrl}`,
    IMPLEMENT_GUIDANCE,
    extraPrompt,
  ]);
}

/** A fresh session with no plugin skill, graded against the Verdict schema. */
export function verifyPrompt(issueUrl: string, extraPrompt: string): string {
  return sections([`Ticket: ${issueUrl}`, VERIFY_INSTRUCTIONS, extraPrompt]);
}

function sections(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n\n");
}
