/**
 * The git working copy a Ticket is implemented in.
 *
 * Each Ticket gets its own worktree on its own branch, so the main checkout is
 * never touched and a failed Ticket leaves something to inspect.
 */

export interface CheckOutcome {
  ok: boolean;
  /** stdout and stderr combined, as a human would see them in a terminal. */
  output: string;
}

export type RebaseOutcome = { ok: true } | { ok: false; conflict: string };

/**
 * Whether the worktree holds a finished rebase, asked after a session has been
 * sent in to resolve one.
 *
 * `unresolved` is what a human would have to be told: a rebase git is still in
 * the middle of, paths it still calls unmerged, conflict markers left in a
 * tracked file, or a branch that no longer sits on top of main at all.
 */
export type RebaseState = { resolved: true } | { resolved: false; unresolved: string };

export interface WorktreeRef {
  path: string;
  branch: string;
}

export interface Workspace {
  /** Create `branch` fresh from main and check it out at `path`. */
  createWorktree(worktree: WorktreeRef): Promise<void>;
  /** Remove the worktree and delete its branch. */
  removeWorktree(worktree: WorktreeRef): Promise<void>;
  /**
   * Whether `path` is still a worktree of this repo, checked out on `branch`.
   *
   * Asked of a released Ticket before a Run resumes into the worktree it kept:
   * a human who has cleaned that worktree up has thrown the resume away with
   * it, and the Ticket is better started over than resumed into nothing.
   */
  hasWorktree(worktree: WorktreeRef): Promise<boolean>;
  /**
   * Subjects of the commits on `branch` that main does not have, oldest first.
   *
   * The order is the port's promise, not an accident of git's default: the
   * first subject names the whole Ticket, and the squash commit lists the rest
   * in the order they were written.
   */
  commitSubjects(branch: string): Promise<string[]>;
  /**
   * The unique `Co-authored-by` trailer values across the branch's commits, in
   * the order first seen. GitHub adds these to a default squash message; the
   * pipeline composes its own, so it has to carry them itself.
   */
  coAuthors(branch: string): Promise<string[]>;
  runCheck(command: string, cwd: string): Promise<CheckOutcome>;
  /** Restore the worktree to its committed state, tracked and untracked. */
  discardChanges(cwd: string): Promise<void>;
  /**
   * Replay the branch onto main.
   *
   * A conflict is reported rather than thrown, and the rebase is left in
   * progress: that stopped state is what a session sent in to resolve the
   * conflict works on. Every caller that gets one therefore owes the worktree
   * either a finished rebase or an {@link abortRebase}.
   */
  rebaseOnMain(cwd: string): Promise<RebaseOutcome>;
  /** What, if anything, still stands between the worktree and a finished rebase. */
  rebaseState(cwd: string): Promise<RebaseState>;
  /**
   * Put the worktree back the way it was before the rebase started. A no-op
   * when no rebase is in progress, so it is safe on any failure path.
   */
  abortRebase(cwd: string): Promise<void>;
  push(cwd: string, branch: string): Promise<void>;
  /** Delete `branch` on the remote; the PR is merged, so nothing references it. */
  deleteRemoteBranch(branch: string): Promise<void>;
  pullMain(): Promise<void>;
}
