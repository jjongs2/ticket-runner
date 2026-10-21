/**
 * Whether a Check a Ticket's branch failed is one it inherited.
 *
 * The Checks run on the Ticket's branch, and CI on its pull request, so a
 * failure alone cannot say whether the branch brought it or the Base branch
 * did. A test that starts failing on the Base branch fails on every branch at
 * once, and a fix Stage per Ticket then mends it differently in each pull
 * request, at the cost of every Ticket's Fix budget. So a failure is graded
 * once more, at what the branch inherited: its merge-base with the Base branch,
 * checked out clean in a worktree of its own. One that fails there too is the
 * Base branch's, and the Ticket is released rather than charged for it.
 */

import { baseWorktreePath } from "./branch.js";
import type { RoutedNote } from "./notes.js";
import type { CheckOutcome, Workspace } from "./ports/workspace.js";

/** A Check command the Base branch fails, and how. */
export interface FailingBase {
  /** The merge-base it fails at, in full. */
  commit: string;
  command: string;
  output: string;
  timedOut: boolean;
}

/** What it takes to run a Check at a merge-base. */
export interface BaseCheckRun {
  workspace: Workspace;
  repoRoot: string;
  /** The Check wall-clock limit, which a Check gets at a merge-base as anywhere. */
  timeoutMs: number;
  log?: (line: string) => void;
}

/**
 * The Run's record of the Checks it ran at merge-bases, and of the Notes it
 * posted about the ones that failed there.
 *
 * A Run has one and every Lane shares it, so the Tickets that fail together
 * over one broken Base branch cost one run of the Check between them, and one
 * Note. Runs at the same commit take turns, because they share its worktree.
 * A run that could not be made — no worktree, no git — is forgotten rather
 * than kept, as a standing Notes lookup that failed is: the Ticket that asked
 * is charged as it always was, and the next one asks again.
 */
export class BaseBranchChecks {
  /** Each command's outcome at each commit, keyed `<commit> <command>`. */
  readonly #outcomes = new Map<string, Promise<CheckOutcome>>();
  /** The last run at each commit, which the next one there waits behind. */
  readonly #turns = new Map<string, Promise<unknown>>();
  /** The Note posted about each commit, or being posted. */
  readonly #notes = new Map<string, Promise<RoutedNote>>();

  /**
   * The first of `commands` that fails at `commit`, run in that order and
   * stopping there as the Checks do, or nothing when the commit passes them
   * all. Each command runs at a commit at most once per Run.
   */
  async firstFailing(
    run: BaseCheckRun,
    commit: string,
    commands: readonly string[],
  ): Promise<FailingBase | undefined> {
    for (const command of commands) {
      const outcome = await this.#outcome(run, commit, command);
      if (!outcome.ok) {
        return { commit, command, output: outcome.output, timedOut: outcome.timedOut };
      }
    }
    return undefined;
  }

  /**
   * Post the Note about `commit` once this Run: the first caller posts it and
   * gets it back, and every caller after it gets nothing. A post that failed
   * is forgotten, so a Ticket that was waiting on it, or one released over the
   * same commit later, tries again.
   */
  async noteOnce(commit: string, post: () => Promise<RoutedNote>): Promise<RoutedNote | undefined> {
    const posted = this.#notes.get(commit);
    if (posted !== undefined) {
      const delivered = await posted.then(
        () => true,
        () => false,
      );
      return delivered ? undefined : await this.noteOnce(commit, post);
    }
    const posting = post();
    this.#notes.set(commit, posting);
    try {
      return await posting;
    } catch (error) {
      this.#notes.delete(commit);
      throw error;
    }
  }

  #outcome(run: BaseCheckRun, commit: string, command: string): Promise<CheckOutcome> {
    const key = `${commit} ${command}`;
    const known = this.#outcomes.get(key);
    if (known !== undefined) return known;

    const before = this.#turns.get(commit) ?? Promise.resolve();
    const outcome = before.catch(() => undefined).then(() => runAt(run, commit, command));
    this.#turns.set(commit, outcome);
    this.#outcomes.set(key, outcome);
    outcome.catch(() => {
      if (this.#outcomes.get(key) === outcome) this.#outcomes.delete(key);
    });
    return outcome;
  }
}

/**
 * One command in a clean worktree at `commit`, which goes again once it has
 * run. A worktree that will not go is logged and nothing more: the outcome is
 * still the answer, and the next run at the commit replaces what is left.
 */
async function runAt(run: BaseCheckRun, commit: string, command: string): Promise<CheckOutcome> {
  const path = baseWorktreePath(run.repoRoot, commit);
  await run.workspace.createDetachedWorktree(path, commit);
  try {
    return await run.workspace.runCheck(command, path, run.timeoutMs);
  } finally {
    try {
      await run.workspace.removeWorktree({ path });
    } catch (error) {
      run.log?.(`could not remove the worktree at ${commit}: ${(error as Error).message}`);
    }
  }
}
