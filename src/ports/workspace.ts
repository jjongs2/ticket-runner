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
   * Subjects of the commits on `branch` that main does not have, oldest first.
   *
   * The order is the port's promise, not an accident of git's default: the
   * first subject names the whole Ticket, and the squash commit lists the rest
   * in the order they were written.
   */
  commitSubjects(branch: string): Promise<string[]>;
  runCheck(command: string, cwd: string): Promise<CheckOutcome>;
  /** Restore the worktree to its committed state, tracked and untracked. */
  discardChanges(cwd: string): Promise<void>;
  rebaseOnMain(cwd: string): Promise<RebaseOutcome>;
  push(cwd: string, branch: string): Promise<void>;
  /** Delete `branch` on the remote; the PR is merged, so nothing references it. */
  deleteRemoteBranch(branch: string): Promise<void>;
  pullMain(): Promise<void>;
}
