import { rmSync } from "node:fs";
import type {
  CheckOutcome,
  WorktreeRef,
  RebaseOutcome,
  Workspace,
} from "../ports/workspace.js";
import { exec, execOrThrow } from "./exec.js";

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

  async runCheck(command: string, cwd: string): Promise<CheckOutcome> {
    const result = await exec(command, [], { cwd, shell: true });
    return { ok: result.exitCode === 0, output: result.output };
  }

  async discardChanges(cwd: string): Promise<void> {
    await execOrThrow("git", ["reset", "--hard"], { cwd });
    // No -x: gitignored files such as node_modules are not the agent's scratch.
    await execOrThrow("git", ["clean", "-fd"], { cwd });
  }

  async rebaseOnMain(cwd: string): Promise<RebaseOutcome> {
    const result = await exec("git", ["rebase", this.mainBranch], { cwd });
    if (result.exitCode === 0) return { ok: true };

    // Leave the worktree usable: a half-finished rebase would trap the human
    // the Ticket is about to be handed to.
    await exec("git", ["rebase", "--abort"], { cwd });
    return { ok: false, conflict: result.output.trim() };
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
    await this.git(["push", this.remote, "--delete", branch]);
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
