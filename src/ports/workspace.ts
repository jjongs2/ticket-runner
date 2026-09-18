/**
 * The git working copy a Ticket is implemented in.
 *
 * Each Ticket gets its own worktree on its own branch, so the main checkout is
 * never touched and a failed Ticket leaves something to inspect.
 *
 * Every operation that names a branch to work against takes it as `base` rather
 * than holding one: the Target's base branch is resolved once at the start of a
 * Run, and a port that kept its own copy would be a second answer to the same
 * question.
 */

/**
 * How one Check command ended. A failed Check says whether the wall-clock limit
 * killed it, because that is the difference between a Check that hung and one
 * that failed, and a fix Stage is told which it is mending.
 */
export type CheckOutcome =
  /** stdout and stderr combined, as a human would see them in a terminal. */
  | { ok: true; output: string }
  | { ok: false; output: string; timedOut: boolean };

export type RebaseOutcome = { ok: true } | { ok: false; conflict: string };

/**
 * Whether the worktree holds a finished rebase, asked after a session has been
 * sent in to resolve one.
 *
 * `unresolved` is what a human would have to be told: a rebase git is still in
 * the middle of, paths it still calls unmerged, conflict markers left in a
 * tracked file, or a branch that no longer sits on top of the base branch at
 * all.
 */
export type RebaseState = { resolved: true } | { resolved: false; unresolved: string };

export interface WorktreeRef {
  path: string;
  branch: string;
}

export interface Workspace {
  /** Create `branch` fresh from `base` and check it out at `path`. */
  createWorktree(worktree: WorktreeRef, base: string): Promise<void>;
  /** Remove the worktree and delete its branch. */
  removeWorktree(worktree: WorktreeRef): Promise<void>;
  /**
   * Whether `path` is still a worktree of this repo, checked out on `branch`.
   *
   * Asked of a resumable Ticket before a Run resumes into the worktree it kept,
   * released or stranded alike: a human who has cleaned that worktree up has
   * thrown the resume away with it, and the Ticket is better started over than
   * resumed into nothing.
   */
  hasWorktree(worktree: WorktreeRef): Promise<boolean>;
  /**
   * Whether `branch` is a branch of this local repo, asked before a Ticket's
   * worktree is created.
   *
   * {@link createWorktree} branches fresh from the base branch and fails on a
   * name that is taken, and a branch nobody can account for is not reused
   * (ADR-0004). Asking first is what lets the Ticket be handed over with a
   * message naming the branch and what to do with it, rather than with git's own.
   *
   * Local only: a branch that exists nowhere but the remote is not one this
   * answers yes about.
   */
  hasBranch(branch: string): Promise<boolean>;
  /**
   * Subjects of the commits on `branch` that `base` does not have, oldest first.
   *
   * The order is the port's promise, not an accident of git's default: the
   * first subject names the whole Ticket, and the squash commit lists the rest
   * in the order they were written.
   */
  commitSubjects(branch: string, base: string): Promise<string[]>;
  /**
   * The unique `Co-authored-by` trailer values across the branch's commits, in
   * the order first seen. GitHub adds these to a default squash message; the
   * pipeline composes its own, so it has to carry them itself.
   */
  coAuthors(branch: string, base: string): Promise<string[]>;
  /**
   * Run one Check command in `cwd`, killing it after `timeoutMs`.
   *
   * The limit is passed per call, not held by the workspace, because it is the
   * config's to decide and every Check gets the whole of it: a Check is a
   * command a user wrote, and without a limit one that hangs stalls the Run for
   * good.
   */
  runCheck(command: string, cwd: string, timeoutMs: number): Promise<CheckOutcome>;
  /** Restore the worktree to its committed state, tracked and untracked. */
  discardChanges(cwd: string): Promise<void>;
  /**
   * Replay the branch checked out at `cwd` onto `base`.
   *
   * A conflict is reported rather than thrown, and the rebase is left in
   * progress: that stopped state is what a session sent in to resolve the
   * conflict works on. Every caller that gets one therefore owes the worktree
   * either a finished rebase or an {@link abortRebase}.
   */
  rebase(cwd: string, base: string): Promise<RebaseOutcome>;
  /** What, if anything, still stands between the worktree and a finished rebase. */
  rebaseState(cwd: string, base: string): Promise<RebaseState>;
  /**
   * Put the worktree back the way it was before the rebase started. A no-op
   * when no rebase is in progress, so it is safe on any failure path.
   */
  abortRebase(cwd: string): Promise<void>;
  push(cwd: string, branch: string): Promise<void>;
  /**
   * Delete `branch` on the remote; the PR is merged, so nothing references it.
   * A branch the remote already deleted, as GitHub does on merge when told to,
   * counts as deleted.
   */
  deleteRemoteBranch(branch: string): Promise<void>;
  /** Fast-forward the main checkout's `base` to the remote, after a merge. */
  pullBase(base: string): Promise<void>;
}
