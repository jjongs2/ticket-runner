import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type LockOptions,
  lockHolder,
  releaseLock,
  takeLock,
  takeOverLock,
} from "../lock.js";
import type {
  CheckOutcome,
  LockHolder,
  LockOutcome,
  LockTake,
  WorktreeRef,
  RebaseOutcome,
  RebaseState,
  StateFile,
  TicketState,
  Workspace,
  WorktreeFromRemote,
} from "../ports/workspace.js";
import {
  readStateFile,
  stateFileContents,
  stateFileName,
  stateFileTicket,
} from "../resume.js";
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
 * The branch of the Target's remote that holds every Ticket's State, one file
 * per Ticket, under the prefix the pipeline owns (ADR-0004).
 */
export const STATE_BRANCH = "agent-pipeline/state";

/**
 * How many times a change to the state branch is made over again when the
 * remote moved between reading it and pushing. The Lanes of one Run take turns,
 * and only one Run holds a Target, so a second attempt is already the unusual
 * case; one that keeps losing is a remote something else is writing to.
 */
const STATE_ATTEMPTS = 3;

/** One entry of the snapshot's tree, as `git ls-tree` names it. */
interface TreeEntry {
  type: string;
  object: string;
  name: string;
}

/**
 * The git-backed {@link Workspace}: one worktree per Ticket, branched from the
 * main checkout's base branch, so the checkout itself is never touched.
 *
 * Commands that run in the main checkout go one at a time, because the Tickets
 * of a Run do not: adding and removing worktrees, deleting branches and moving
 * the Base branch all take git refs and index locks that git fails on rather
 * than waits for, and a read of a commit range taken while another Ticket is
 * moving the Base branch is a range nobody asked for. Commands inside a
 * worktree are left parallel — that is where a Run spends its time, and no two
 * Tickets share one.
 *
 * One command at a time, not one operation: the two commands an operation such
 * as {@link removeWorktree} is made of can have another Ticket's between them.
 * What each of them needs is a main checkout nobody else is writing to while it
 * runs, which is what this gives; a pair that had to be indivisible would have
 * to say so, and none of them is.
 *
 * The State lives on the Target's remote, on {@link STATE_BRANCH}, so a Run on
 * any Host resumes a Ticket another left (ADR-0004). The branch is one snapshot
 * commit, rewritten whole and force-pushed with a lease on the tip it was built
 * from, and built from objects and a scratch index alone: the main checkout's
 * tree, index and branches are never touched. Each change to it takes a turn of
 * its own, whole — read, rewrite, push — because two Lanes that rewrote the
 * same tip would each push a snapshot missing the other's Ticket.
 *
 * The Run lock is still a plain file under the gitignored run directory, with a
 * PID check telling a live lock from an abandoned one. It takes no git ref or
 * index lock, so it is not queued behind git.
 */
export class GitWorkspace implements Workspace {
  /**
   * Main-checkout commands, one at a time. A command that failed is still a
   * command that finished, so the queue carries on rather than rejecting
   * everything behind it.
   */
  private readonly mainCheckout = new Turns();
  /** Changes to the state branch, and reads of it, one whole operation at a time. */
  private readonly stateBranch = new Turns();

  constructor(
    private readonly repoRoot: string,
    private readonly remote = "origin",
    /** How the Run lock tells a live holder; the real process table by default. */
    private readonly lockOptions: LockOptions = {},
  ) {}

  async createWorktree({ path, branch }: WorktreeRef, base: string): Promise<void> {
    await this.git(["worktree", "add", "-b", branch, path, base]);
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
   * The remote branch is fetched into its remote-tracking ref, which is also
   * what the lease of every later {@link push} is taken against: a push from
   * here then overwrites only the tip this Host last saw.
   *
   * A rebase a Run was killed in the middle of is aborted first, because it
   * leaves the worktree detached rather than on its branch, and git would
   * then neither list the worktree as the branch's nor let it be checked out
   * anywhere else.
   */
  async worktreeFromRemote({ path, branch }: WorktreeRef): Promise<WorktreeFromRemote> {
    // Only in a directory that is itself a worktree: git run anywhere else
    // under the repo would find the main checkout, and abort a human's rebase.
    if (existsSync(join(path, ".git"))) await this.abortRebase(path);
    const here = await this.hasWorktree({ path, branch });
    const remoteRef = await this.fetchBranch(branch);
    if (remoteRef === undefined) return here ? "kept" : "gone";

    const localRef = `refs/heads/${branch}`;
    if (here || (await this.hasBranch(branch))) {
      // A rebase this Host made and never pushed rewrote every commit the
      // remote has, so it is told from another Host's work by what the commits
      // change rather than by their ids.
      if (
        (await this.contains(localRef, remoteRef)) ||
        (await this.replays(localRef, remoteRef))
      ) {
        if (!here) await this.addWorktree([path, branch]);
        return here ? "kept" : "made";
      }
      if (!(await this.contains(remoteRef, localRef))) return "parted";
      // Behind the remote and nothing more: every commit here is one the
      // remote already has, so moving up to it loses nothing.
      if (here) {
        await execOrThrow("git", ["merge", "--ff-only", remoteRef], { cwd: path });
        return "kept";
      }
    }

    // -B, because a branch left behind without its worktree is by now known to
    // hold nothing the remote lacks, and is moved to the remote tip.
    await this.addWorktree(["-B", branch, path, remoteRef]);
    return "made";
  }

  /**
   * `worktree add`, after git has forgotten any worktree whose directory a
   * human deleted: git refuses to check a branch out where it still believes
   * one is.
   */
  private async addWorktree(args: string[]): Promise<void> {
    await this.git(["worktree", "prune"]);
    await this.git(["worktree", "add", ...args]);
  }

  /**
   * Fetch `branch` from the remote into its remote-tracking ref and name that
   * ref, or nothing when the remote has no such branch. Forced, because the
   * remote branch is rewritten by every rebase that is pushed.
   */
  private async fetchBranch(branch: string): Promise<string | undefined> {
    const { stdout } = await this.git([
      "ls-remote",
      "--heads",
      this.remote,
      `refs/heads/${branch}`,
    ]);
    const tracking = `refs/remotes/${this.remote}/${branch}`;
    if (stdout.trim() === "") {
      // A tip the remote no longer has would be the lease of the next push,
      // and refuse it: the push is then creating the branch, not replacing it.
      await this.tryGit(["update-ref", "-d", tracking]);
      return undefined;
    }

    await this.git(["fetch", this.remote, `+refs/heads/${branch}:${tracking}`]);
    return tracking;
  }

  /** Whether `ref` holds every commit `other` does. */
  private async contains(ref: string, other: string): Promise<boolean> {
    const result = await this.tryGit(["merge-base", "--is-ancestor", other, ref]);
    return result.exitCode === 0;
  }

  /**
   * Whether `ref` makes every change `other` makes, under other commit ids:
   * `git cherry` marks a commit of `other` with `+` when `ref` has no commit
   * with the same patch.
   */
  private async replays(ref: string, other: string): Promise<boolean> {
    const { stdout } = await this.git(["cherry", ref, other]);
    return !stdout.split("\n").some((line) => line.startsWith("+"));
  }

  /**
   * A ref lookup, never the output of a failed `worktree add`: the branch is
   * asked about before anything is created, and `refs/heads/` is spelt out so a
   * tag or a remote-tracking ref of the same name is not mistaken for a branch.
   */
  async hasBranch(branch: string): Promise<boolean> {
    const result = await this.tryGit([
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return result.exitCode === 0;
  }

  async commitSubjects(branch: string, base: string): Promise<string[]> {
    // --reverse turns git's newest-first log into the order they were written.
    const { stdout } = await this.git([
      "log",
      "--reverse",
      "--format=%s",
      `${base}..${branch}`,
    ]);
    // Only git's trailing newline is dropped: a commit with an empty subject is
    // still a commit, and losing it would shift which one counts as the first.
    const subjects = stdout.split("\n");
    if (subjects.at(-1) === "") subjects.pop();
    return subjects;
  }

  async coAuthors(branch: string, base: string): Promise<string[]> {
    const { stdout } = await this.git([
      "log",
      "--reverse",
      "--format=%(trailers:key=Co-authored-by,valueonly)",
      `${base}..${branch}`,
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
    return { ok: false, output: result.output, timedOut: result.timedOut };
  }

  /**
   * NUL-separated, so a path git would otherwise quote comes back as it is
   * spelt. Ignored files stay out, which is git's default; a whole untracked
   * directory is named once, as the directory, which is also git's default.
   * The untracked mode is spelt out so a Target's status.showUntrackedFiles
   * cannot hide an uncommitted file.
   */
  async uncommittedPaths(cwd: string): Promise<string[]> {
    const { stdout } = await execOrThrow(
      "git",
      ["status", "--porcelain", "-z", "--untracked-files=normal"],
      { cwd },
    );
    const entries = stdout.split("\0");
    const paths: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] ?? "";
      if (entry === "") continue;
      paths.push(entry.slice(3));
      // A rename or a copy is followed by the path it came from, which no
      // longer holds anything to commit.
      if (/[RC]/.test(entry.slice(0, 2))) i++;
    }
    return paths;
  }

  async discardChanges(cwd: string): Promise<void> {
    await execOrThrow("git", ["reset", "--hard"], { cwd });
    // No -x: gitignored files such as node_modules are not the agent's scratch.
    await execOrThrow("git", ["clean", "-fd"], { cwd });
  }

  async rebase(cwd: string, base: string): Promise<RebaseOutcome> {
    const result = await exec("git", ["rebase", base], { cwd });
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
  async rebaseState(cwd: string, base: string): Promise<RebaseState> {
    const reasons: string[] = [];

    if (await this.rebaseInProgress(cwd)) {
      reasons.push("a rebase is still in progress");
    } else if (!(await this.isRebasedOn(cwd, base))) {
      reasons.push(`the branch is not rebased onto ${base}`);
    } else {
      // Being on top of the base branch is not the same as having been replayed
      // onto it: merging it in would satisfy the ancestry and put a merge commit
      // on a branch whose every commit is about to be listed in a squash message.
      const merges = await this.lines(cwd, ["rev-list", "--merges", `${base}..HEAD`]);
      if (merges.length > 0) {
        reasons.push(`the conflict was merged into the branch, not rebased onto ${base}`);
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

  private async isRebasedOn(cwd: string, base: string): Promise<boolean> {
    const result = await exec("git", ["merge-base", "--is-ancestor", base, "HEAD"], {
      cwd,
    });
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
    const result = await this.tryGit(args);
    // A remote set to delete head branches on merge got there first. The
    // branch is gone either way, which is all this step is for.
    if (result.exitCode !== 0 && BRANCH_ALREADY_GONE.test(result.stderr)) return;
    throwOnFailure("git", args, result);
  }

  async pullBase(base: string): Promise<void> {
    const { stdout } = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (stdout.trim() === base) {
      await this.git(["pull", "--ff-only", this.remote, base]);
      return;
    }
    // The base branch is not checked out here, so move the ref without
    // touching the tree.
    await this.git(["fetch", this.remote, `${base}:${base}`]);
  }

  async readState(ticket: number): Promise<TicketState | undefined> {
    return this.stateBranch.take(async () => {
      const tip = await this.fetchBranch(STATE_BRANCH);
      if (tip === undefined) return undefined;
      const read = await this.tryGit(["cat-file", "blob", `${tip}:${stateFileName(ticket)}`]);
      if (read.exitCode !== 0) return undefined;
      const file = readStateFile(read.stdout, ticket);
      return file.readable ? file.state : undefined;
    });
  }

  async readAllStates(): Promise<StateFile[]> {
    return this.stateBranch.take(async () => {
      const tip = await this.fetchBranch(STATE_BRANCH);
      if (tip === undefined) return [];
      const files = (await this.snapshot(tip)).flatMap((entry) => {
        const ticket = stateFileTicket(entry.name);
        return entry.type === "blob" && ticket !== undefined ? [{ ticket, entry }] : [];
      });
      files.sort((a, b) => a.ticket - b.ticket);
      const read: StateFile[] = [];
      for (const { ticket, entry } of files) {
        const { stdout } = await this.git(["cat-file", "blob", entry.object]);
        read.push(readStateFile(stdout, ticket));
      }
      return read;
    });
  }

  async writeState(state: TicketState): Promise<void> {
    await this.changeState(`Record #${state.ticket} at ${state.state}`, {
      name: stateFileName(state.ticket),
      contents: stateFileContents(state),
    });
  }

  async removeState(ticket: number): Promise<void> {
    await this.changeState(`Forget #${ticket}`, { name: stateFileName(ticket) });
  }

  /**
   * Rewrite the state branch as one new snapshot commit, the same as the tip
   * but for the file `edit` names — written with its contents, or removed where
   * it has none — and push it over the tip it was built from. Removing a file
   * the tip does not have pushes nothing, so a remove never creates the branch.
   *
   * No parent, because nothing reads the branch's history and a branch that
   * grew with every Stage would grow the Target with it. The lease is on the
   * tip read, or on no branch at all where there was none, so a snapshot that
   * another writer moved on since is never overwritten: it is read again and
   * the edit made over it.
   */
  private async changeState(
    message: string,
    edit: { name: string; contents?: string },
  ): Promise<void> {
    await this.stateBranch.take(async () => {
      for (let attempt = 1; ; attempt++) {
        const tracking = await this.fetchBranch(STATE_BRANCH);
        const tip =
          tracking === undefined
            ? undefined
            : (await this.git(["rev-parse", tracking])).stdout.trim();
        if (edit.contents === undefined) {
          const had =
            tip !== undefined &&
            (await this.tryGit(["cat-file", "-e", `${tip}:${edit.name}`])).exitCode === 0;
          if (!had) return;
        }

        const tree = await this.editTree(tip, edit);
        const { stdout } = await this.git(["commit-tree", tree, "-m", message]);
        const args = [
          "push",
          // The state branch holds no code, so a Target's pre-push hooks have
          // nothing to check on it.
          "--no-verify",
          `--force-with-lease=refs/heads/${STATE_BRANCH}:${tip ?? ""}`,
          this.remote,
          `${stdout.trim()}:refs/heads/${STATE_BRANCH}`,
        ];
        const pushed = await this.tryGit(args);
        if (pushed.exitCode === 0) return;
        if (attempt === STATE_ATTEMPTS) throwOnFailure("git", args, pushed);
      }
    });
  }

  /** The entries at the top of the snapshot `tip` is, files and directories alike. */
  private async snapshot(tip: string): Promise<TreeEntry[]> {
    const { stdout } = await this.git(["ls-tree", "-z", tip]);
    return stdout
      .split("\0")
      .filter((line) => line !== "")
      .map((line) => {
        // `<mode> <type> <object>\t<name>`, the name spelt as it is under -z.
        const tab = line.indexOf("\t");
        const [, type = "", object = ""] = line.slice(0, tab).split(" ");
        return { type, object, name: line.slice(tab + 1) };
      });
  }

  /**
   * The tree `tip` has with `edit` made to it, built in a scratch index so the
   * main checkout's own index is never the one written. The blob goes through
   * a scratch file too, because `exec` gives a child no stdin to read it from.
   */
  private async editTree(
    tip: string | undefined,
    edit: { name: string; contents?: string },
  ): Promise<string> {
    return this.withScratch(async (scratch) => {
      const env = { GIT_INDEX_FILE: join(scratch, "index") };
      await this.git(["read-tree", ...(tip === undefined ? ["--empty"] : [tip])], env);
      if (edit.contents === undefined) {
        await this.git(["update-index", "--force-remove", "--", edit.name], env);
      } else {
        const path = join(scratch, "blob");
        writeFileSync(path, edit.contents);
        const blob = (await this.git(["hash-object", "-w", "--", path])).stdout.trim();
        await this.git(
          ["update-index", "--add", "--cacheinfo", `100644,${blob},${edit.name}`],
          env,
        );
      }
      const { stdout } = await this.git(["write-tree"], env);
      return stdout.trim();
    });
  }

  private async withScratch<T>(use: (scratch: string) => Promise<T>): Promise<T> {
    const scratch = mkdtempSync(join(tmpdir(), "agent-pipeline-state-"));
    try {
      return await use(scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  async takeRunLock(holder: LockHolder): Promise<LockTake> {
    return takeLock(this.repoRoot, holder, this.lockOptions);
  }

  async takeOverRunLock(holder: LockHolder): Promise<LockOutcome> {
    return takeOverLock(this.repoRoot, holder, this.lockOptions);
  }

  async runLockHolder(): Promise<LockHolder | undefined> {
    return lockHolder(this.repoRoot, this.lockOptions);
  }

  async releaseRunLock(): Promise<void> {
    releaseLock(this.repoRoot);
  }

  /**
   * A git command in the main checkout, waiting its turn. Every command this
   * class runs there goes through here or through {@link tryGit}, so a new one
   * is serialized by being written the way the others are.
   */
  private git(args: string[], extraEnv?: Record<string, string>) {
    return this.mainCheckout.take(() =>
      execOrThrow("git", args, { cwd: this.repoRoot, ...(extraEnv && { extraEnv }) }),
    );
  }

  /** The same, for a command whose failure is an answer rather than an error. */
  private tryGit(args: string[]) {
    return this.mainCheckout.take(() => exec("git", args, { cwd: this.repoRoot }));
  }
}

/**
 * Work that takes turns: each piece waits for the last one queued to settle,
 * either way, before it starts.
 */
class Turns {
  private last: Promise<unknown> = Promise.resolve();

  take<T>(work: () => Promise<T>): Promise<T> {
    const started = this.last.then(work, work);
    this.last = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  }
}
