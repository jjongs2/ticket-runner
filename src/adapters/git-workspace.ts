import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CheckOutcome,
  WorktreeRef,
  RebaseOutcome,
  RebaseState,
  Workspace,
} from "../ports/workspace.js";
import { exec, execOrThrow, throwOnFailure } from "./exec.js";

/**
 * The start of a line git only writes when it cannot merge two hunks itself.
 * Anchored, so a marker quoted inside source or prose is not mistaken for one:
 * a real marker is the whole line, label and all.
 */
const CONFLICT_MARKER = "^(<{7}|>{7}|\\|{7}) ";

/** What git says to a `push --delete` of a branch the remote no longer has. */
const BRANCH_ALREADY_GONE = /remote ref does not exist/;

/** The two directories git keeps a rebase in, depending on which one it used. */
const REBASE_DIRS = ["rebase-merge", "rebase-apply"];

/**
 * The git-backed {@link Workspace}: one worktree per Ticket, branched from the
 * main checkout's `main`, so the checkout itself is never touched.
 */
export class GitWorkspace implements Workspace {
  constructor(
    private readonly repoRoot: string,
    private readonly mainBranch = "main",
    private readonly remote = "origin",
  ) {}

  async createWorktree({ path, branch }: WorktreeRef): Promise<void> {
    await this.git(["worktree", "add", "-b", branch, path, this.mainBranch]);
  }

  async removeWorktree({ path, branch }: WorktreeRef): Promise<void> {
    await this.git(["worktree", "remove", "--force", path]);
    // A worktree directory left behind would block the next Run on this Ticket.
    rmSync(path, { recursive: true, force: true });
    await this.git(["branch", "-D", branch]);
  }

  /**
   * Both halves are asked, because either can go on its own: a human who
   * deleted the directory leaves git listing the worktree until somebody prunes
   * it, and a worktree moved onto another branch is no longer holding the work
   * that was left there.
   */
  async hasWorktree({ path, branch }: WorktreeRef): Promise<boolean> {
    if (!existsSync(path)) return false;

    const { stdout } = await this.git(["worktree", "list", "--porcelain"]);
    // One paragraph per worktree: its path, then the branch it is on unless it
    // is detached. Paths are compared resolved, because the one git recorded
    // and the one the pipeline composed need not be spelt the same.
    for (const entry of stdout.split("\n\n")) {
      const lines = entry.split("\n");
      const listed = lines.find((line) => line.startsWith("worktree "))?.slice(9);
      if (listed === undefined || resolve(listed) !== resolve(path)) continue;
      return lines.includes(`branch refs/heads/${branch}`);
    }
    return false;
  }

  /**
   * A ref lookup, never the output of a failed `worktree add`: the branch is
   * asked about before anything is created, and `refs/heads/` is spelt out so a
   * tag or a remote-tracking ref of the same name is not mistaken for a branch.
   */
  async hasBranch(branch: string): Promise<boolean> {
    const result = await exec(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: this.repoRoot },
    );
    return result.exitCode === 0;
  }

  async commitSubjects(branch: string): Promise<string[]> {
    // --reverse turns git's newest-first log into the order they were written.
    const { stdout } = await this.git([
      "log",
      "--reverse",
      "--format=%s",
      `${this.mainBranch}..${branch}`,
    ]);
    // Only git's trailing newline is dropped: a commit with an empty subject is
    // still a commit, and losing it would shift which one counts as the first.
    const subjects = stdout.split("\n");
    if (subjects.at(-1) === "") subjects.pop();
    return subjects;
  }

  async coAuthors(branch: string): Promise<string[]> {
    const { stdout } = await this.git([
      "log",
      "--reverse",
      "--format=%(trailers:key=Co-authored-by,valueonly)",
      `${this.mainBranch}..${branch}`,
    ]);
    const seen = new Set<string>();
    for (const line of stdout.split("\n")) {
      const value = line.trim();
      if (value !== "") seen.add(value);
    }
    return [...seen];
  }

  /**
   * The kill reaches the shell the command runs in, not whatever it started:
   * a test runner left behind is tolerated, the same trade `exec` already makes
   * when it drains a dead child's pipes on a clock.
   */
  async runCheck(command: string, cwd: string, timeoutMs: number): Promise<CheckOutcome> {
    const result = await exec(command, [], { cwd, shell: true, timeoutMs });
    if (result.exitCode === 0) return { ok: true, output: result.output };
    // Asked of the run rather than read off the exit code: a Check is free to
    // exit 124 itself, and only `exec` knows whether it was killed.
    return { ok: false, output: result.output, timedOut: result.timedOut === true };
  }

  async discardChanges(cwd: string): Promise<void> {
    await execOrThrow("git", ["reset", "--hard"], { cwd });
    // No -x: gitignored files such as node_modules are not the agent's scratch.
    await execOrThrow("git", ["clean", "-fd"], { cwd });
  }

  async rebaseOnMain(cwd: string): Promise<RebaseOutcome> {
    const result = await exec("git", ["rebase", this.mainBranch], { cwd });
    if (result.exitCode === 0) return { ok: true };

    // The rebase is deliberately left where it stopped: the conflict Stage
    // needs the conflicted tree, and the caller owes the worktree an
    // `abortRebase` if it decides not to send one in.
    return { ok: false, conflict: result.output.trim() };
  }

  /**
   * Every way a worktree can still be short of a finished rebase, gathered into
   * one answer so nothing downstream has to ask git itself.
   *
   * The ancestry check is what catches the resolution nobody asked for: a
   * session that gave up and ran `git rebase --abort` leaves a tree as clean as
   * a finished rebase, on a branch that has never met the commits it conflicts
   * with.
   */
  async rebaseState(cwd: string): Promise<RebaseState> {
    const reasons: string[] = [];

    if (await this.rebaseInProgress(cwd)) {
      reasons.push("a rebase is still in progress");
    } else if (!(await this.isRebasedOnMain(cwd))) {
      reasons.push(`the branch is not rebased onto ${this.mainBranch}`);
    } else {
      // Being on top of main is not the same as having been replayed onto it:
      // merging main in would satisfy the ancestry and put a merge commit on a
      // branch whose every commit is about to be listed in a squash message.
      const merges = await this.lines(cwd, [
        "rev-list",
        "--merges",
        `${this.mainBranch}..HEAD`,
      ]);
      if (merges.length > 0) {
        reasons.push(`the conflict was merged into the branch, not rebased onto ${this.mainBranch}`);
      }
    }

    const unmerged = await this.lines(cwd, ["diff", "--name-only", "--diff-filter=U"]);
    if (unmerged.length > 0) reasons.push(`unmerged paths: ${unmerged.join(", ")}`);

    // --untracked, because a marker in a file nobody staged is still a marker
    // in the tree; ignored files stay out, so node_modules is not searched.
    // -I: a binary file that happens to hold those bytes is not a conflict.
    const marked = await this.lines(cwd, [
      "grep",
      "--files-with-matches",
      "--untracked",
      "-I",
      "-E",
      CONFLICT_MARKER,
    ]);
    if (marked.length > 0) reasons.push(`conflict markers left in: ${marked.join(", ")}`);

    return reasons.length === 0
      ? { resolved: true }
      : { resolved: false, unresolved: reasons.join("\n") };
  }

  async abortRebase(cwd: string): Promise<void> {
    // Non-zero only when there was no rebase to abort, which is the outcome
    // this asks for anyway.
    await exec("git", ["rebase", "--abort"], { cwd });
  }

  private async rebaseInProgress(cwd: string): Promise<boolean> {
    const paths = await this.lines(cwd, [
      "rev-parse",
      ...REBASE_DIRS.flatMap((dir) => ["--git-path", dir]),
    ]);
    // --git-path answers relative to the worktree it was asked in.
    return paths.some((path) => existsSync(resolve(cwd, path)));
  }

  private async isRebasedOnMain(cwd: string): Promise<boolean> {
    const result = await exec(
      "git",
      ["merge-base", "--is-ancestor", this.mainBranch, "HEAD"],
      { cwd },
    );
    return result.exitCode === 0;
  }

  /** A git command whose output is one path per line, and none when it finds none. */
  private async lines(cwd: string, args: string[]): Promise<string[]> {
    const { stdout } = await exec("git", args, { cwd });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  }

  async push(cwd: string, branch: string): Promise<void> {
    // The rebase rewrote the branch, so an earlier push has to be overwritten.
    await execOrThrow(
      "git",
      ["push", "--force-with-lease", "--set-upstream", this.remote, branch],
      { cwd },
    );
  }

  async deleteRemoteBranch(branch: string): Promise<void> {
    const args = ["push", this.remote, "--delete", branch];
    const result = await exec("git", args, { cwd: this.repoRoot });
    // A remote set to delete head branches on merge got there first. The
    // branch is gone either way, which is all this step is for.
    if (result.exitCode !== 0 && BRANCH_ALREADY_GONE.test(result.stderr)) return;
    throwOnFailure("git", args, result);
  }

  async pullMain(): Promise<void> {
    const { stdout } = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (stdout.trim() === this.mainBranch) {
      await this.git(["pull", "--ff-only", this.remote, this.mainBranch]);
      return;
    }
    // main is not checked out here, so move the ref without touching the tree.
    await this.git(["fetch", this.remote, `${this.mainBranch}:${this.mainBranch}`]);
  }

  private git(args: string[]) {
    return execOrThrow("git", args, { cwd: this.repoRoot });
  }
}
