import type { Host } from "../host.js";

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
 *
 * It also keeps the pipeline's own bookkeeping about the Target: the State each
 * resumable Ticket keeps, and the Run lock. Where those live is the adapter's
 * business (ADR-0004), so nothing above the port says whether they are files,
 * a branch, or a map in a test.
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

/**
 * How far a Ticket got: `claimed` is one the implement Stage never finished,
 * `implemented` one carrying that Stage's work on its branch with no merge
 * behind it.
 *
 * A state of the lifecycle, not a Stage — a Stage is a session (CONTEXT.md), and
 * what the State records is what the Ticket has, not what was running. Only these
 * two, because everything after the implement Stage — the Checks, the rebase,
 * the pull request, CI and the merge — is re-run from the top by a Run that
 * resumes at `implemented`, and none of them is worth a state a resume could
 * land on halfway.
 */
export const REACHED_STATES = ["claimed", "implemented"] as const;

export type ReachedState = (typeof REACHED_STATES)[number];

/** The State a Ticket keeps while its branch carries work worth resuming. */
export interface TicketState {
  /** Carried in the State as well as its name, so it reads on its own. */
  ticket: number;
  /** The branch the work is on, which the resuming Run uses rather than deriving. */
  branch: string;
  /** The state the Ticket had reached, which is where a later Run picks it up. */
  state: ReachedState;
  /**
   * Whether the Fix budget has been spent. Resuming must not hand the Ticket a
   * second fix Stage it never earned — except after a hand-off, which records it
   * unspent, the Ticket having been through a human's hands since.
   */
  fixUsed: boolean;
  /**
   * The pull request the Ticket already has, if it got that far. Without it the
   * resuming Run would try to open a second one for the branch.
   */
  pullRequest?: number;
  /** The Run that last wrote the State, and when — both for a human reading it. */
  runId: string;
  /**
   * The Version that wrote the State (ADR-0007). Written on every write, and
   * optional when read: State an earlier pipeline left names none, and a
   * Ticket claimed before this existed still resumes.
   */
  version?: string;
  /** ISO 8601. */
  updatedAt: string;
}

/**
 * What one Ticket's recorded State turned out to be.
 *
 * Two cases, where no State at all is a third: State a Run can resume from, and
 * State it cannot. The second is the one that most needs saying out loud: its
 * Ticket is claimed on the board, so the sweep for Stranded Tickets is the only
 * thing that could ever have found it (ADR-0007).
 */
export type StateFile =
  | { readable: true; state: TicketState }
  | {
      readable: false;
      /** Read off where the State was kept, which is the only part of it that parsed. */
      ticket: number;
      /** The Version the State names, where it names one a reader can make out. */
      version?: string;
    };

/** Who holds the Run lock: one Run at a time per Target, whichever Host it is on. */
export interface LockHolder {
  /**
   * The Host the holder runs on. Only a Run on that same Host can see whether
   * the process below is still running, so a holder on another Host is never
   * presumed gone (ADR-0008).
   */
  host: Host;
  pid: number;
  /** The command line the holder is running, for the message the loser prints. */
  command: string;
  runId: string;
  /** ISO 8601, so the lock is readable without the pipeline. */
  startedAt: string;
  /**
   * The holder process's start time as the operating system reports it, taken
   * when the lock was claimed. Distinct from `startedAt` above, which is the
   * Run's own wall clock, written for a human reading the lock.
   *
   * A pid a lock names can be recycled — by a wrapped counter, or by a reboot
   * climbing back through the numbers a pre-reboot Run was using — so a live
   * pid alone cannot say the process behind it is still the holder. This is
   * what a recycled pid cannot forge. Absent when it could not be read, or
   * when the lock predates this field; either way a live pid alone is treated
   * as the holder, which is what this check has always done.
   *
   * An opaque token, not a timestamp to parse or display: its shape is
   * whatever the platform's own record of it looks like (kernel ticks on
   * Linux, a `ps` field on macOS), good for nothing but comparing a pid's
   * past and present selves on the same host.
   */
  processStartedAt?: string;
}

/**
 * What a Run asks the lock to record about itself. The Host and the process's
 * own start time are the Workspace's to read, not a caller's to vouch for.
 */
export type LockClaim = Pick<LockHolder, "pid" | "command" | "runId" | "startedAt">;

/**
 * A lock somebody holds, and whether they hold it from another Host, which is
 * the difference between a Run to wait for here and one a human releases.
 */
export interface HeldLock {
  holder: LockHolder;
  onAnotherHost: boolean;
}

/** Whether a Run got the lock, and who has it when it did not. */
export type LockOutcome = { outcome: "taken" } | ({ outcome: "held" } & HeldLock);

/**
 * What an attempt to take the lock found. `abandoned` is a lock a Run on this
 * same Host held and whose process has gone, and is the one a Run may take
 * over; a holder on another Host is never abandoned, only `held`.
 */
export type LockTake = LockOutcome | { outcome: "abandoned" };

/**
 * Where a handed-off Ticket's transcripts were kept on the remote: a branch, and
 * the directory on it, spelt as a human looking for them would look them up.
 */
export interface KeptTranscripts {
  branch: string;
  /** Ends in `/`, so it reads as the directory it is. */
  path: string;
}

export interface WorktreeRef {
  path: string;
  branch: string;
}

/**
 * Where a resumed Ticket's worktree came from, measured against its branch on
 * the remote, which is what carries a Ticket's work between Hosts (ADR-0004).
 *
 * - `made`: this Host had no worktree of the branch, so one was made from the
 *   remote branch
 * - `kept`: this Host's worktree contains the remote branch, which is a Run on
 *   this Host that died before it pushed, and it is used as it is. A rebase
 *   of the remote branch this Host never pushed contains it too, since it
 *   makes every change the remote's commits make
 * - `parted`: this Host's copy and the remote branch each carry commits the
 *   other lacks, so another Host moved on while this one held work it never
 *   pushed, and nothing is touched
 * - `gone`: neither this Host nor the remote has the branch
 */
export type WorktreeFromRemote = "made" | "kept" | "parted" | "gone";

export interface Workspace {
  /** Create `branch` fresh from `base` and check it out at `path`. */
  createWorktree(worktree: WorktreeRef, base: string): Promise<void>;
  /** Remove the worktree and delete its branch. */
  removeWorktree(worktree: WorktreeRef): Promise<void>;
  /**
   * Whether `path` is still a worktree of this repo, checked out on `branch`.
   *
   * Asked of a branch in the way of a Ticket taken from the top, and of one
   * parted from the remote, because a hand-off over either sends the human to
   * the worktree the branch is checked out in, when it is in one.
   */
  hasWorktree(worktree: WorktreeRef): Promise<boolean>;
  /**
   * Ready the worktree a resumed Ticket carries on in, from its branch on the
   * remote rather than from whatever this Host happens to have.
   *
   * A rebase a dead Run left in progress is aborted first. A worktree already
   * here is kept only when it contains the remote branch, unpushed commits and
   * all. One the remote has merely moved ahead of is
   * brought up to it, since it holds nothing the remote lacks. One that has
   * parted from the remote branch is reported and left exactly as it is, as is
   * the remote: choosing between the two is a human's call. A branch this Host
   * kept without its worktree is measured the same way.
   *
   * A worktree here and no branch on the remote is kept too: a Run on this Host
   * that died before its first push.
   */
  worktreeFromRemote(worktree: WorktreeRef): Promise<WorktreeFromRemote>;
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
  /**
   * The paths in the worktree at `cwd` that no commit carries: tracked files
   * modified or staged, and untracked files git does not ignore. None when the
   * worktree is exactly its branch tip.
   *
   * Asked before the Checks grade a pass, because the branch is what lands and
   * a Stage that left its last changes uncommitted would otherwise be graded on
   * code the pull request never carries.
   */
  uncommittedPaths(cwd: string): Promise<string[]>;
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
  /**
   * Push `branch` from the worktree at `cwd`, overwriting what the remote has
   * only when it is what this Host last saw there: a rebase rewrites the
   * branch, and another Host's newer work must not be.
   *
   * Pushed after every Stage that commits, not only at the pull request, so a
   * Host that vanishes mid-Ticket loses no committed work.
   */
  push(cwd: string, branch: string): Promise<void>;
  /**
   * Whether the remote has `branch`, asked by a hand-off so its comment says
   * where the work is once this Host is gone only when that is true.
   */
  hasRemoteBranch(branch: string): Promise<boolean>;
  /**
   * Delete `branch` on the remote; the PR is merged, so nothing references it.
   * A branch the remote already deleted, as GitHub does on merge when told to,
   * counts as deleted without a delete being sent, which a cloud Host could not.
   */
  deleteRemoteBranch(branch: string): Promise<void>;
  /** Fast-forward the main checkout's `base` to the remote, after a merge. */
  pullBase(base: string): Promise<void>;

  /**
   * The State `ticket` keeps, when a Run can resume from it.
   *
   * State nothing wrote, and State this pipeline cannot read, are both
   * undefined: starting the Ticket over is always safe, and resuming on a guess
   * is not.
   */
  readState(ticket: number): Promise<TicketState | undefined>;
  /**
   * Every Ticket's State, in ascending Ticket number, the unreadable ones
   * included: their Tickets are claimed, and the sweep is what tells a human
   * they are there.
   */
  readAllStates(): Promise<StateFile[]>;
  /** Record `state` as its Ticket's, replacing whatever was there. */
  writeState(state: TicketState): Promise<void>;
  /**
   * Forget `ticket` is resumable, and the transcripts {@link keepTranscripts}
   * kept beside its State with it. A Ticket with no State is not an error.
   */
  removeState(ticket: number): Promise<void>;
  /**
   * Keep the command lines and transcripts of the Stages Run `runId` ran for
   * `ticket` beside its State, where a human can still read them once this
   * Host is gone. Asked of a hand-off, and nothing else: a Ticket nobody has to
   * look into leaves nothing behind.
   *
   * Where they were kept, for the hand-off comment to name, or nothing when
   * the Run left none for the Ticket.
   */
  keepTranscripts(ticket: number, runId: string): Promise<KeptTranscripts | undefined>;
  /**
   * Take the Run lock for this Run, or say what stands in the way. Taking it is
   * the whole of the mutual exclusion: two Runs never both get `taken`, on one
   * Host or on two.
   */
  takeRunLock(claim: LockClaim): Promise<LockTake>;
  /**
   * Take a lock {@link takeRunLock} found `abandoned`. A Run that took it in
   * the meantime is `held` again, and is not taken from.
   */
  takeOverRunLock(claim: LockClaim): Promise<LockOutcome>;
  /**
   * Who holds the Run lock, when anybody still does. An abandoned lock has no
   * holder, and is left exactly where it is: taking it over belongs to a Run
   * that is actually starting, where this only reads.
   */
  runLockHolder(): Promise<HeldLock | undefined>;
  /**
   * Give up the Run lock this Workspace took. A lock somebody else holds by
   * now — a human released this Run's and another Run took it — is theirs,
   * and is left alone.
   */
  releaseRunLock(): Promise<void>;
}
