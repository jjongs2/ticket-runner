import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorkspace } from "./git-workspace.js";

let remote: string;
let repo: string;
let workspace: GitWorkspace;
const created: string[] = [];

function git(cwd: string, ...args: string[]): string {
  // Pipe stderr so git's progress chatter stays out of the test output.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(cwd: string, file: string, contents: string, message: string): void {
  writeFileSync(join(cwd, file), contents);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", message);
}

/** A branch whose one commit edits the same line main went on to edit. */
function conflictingWorktree(): string {
  const path = join(repo, ".worktrees", "ticket-2");
  execFileSync("git", ["worktree", "add", "-b", "agent/2-x", path, "main"], {
    cwd: repo,
    stdio: "ignore",
  });
  commit(path, "README.md", "branch version\n", "feat: branch edit (#2)");
  commit(repo, "README.md", "main version\n", "feat: main edit (#1)");
  return path;
}

beforeEach(() => {
  remote = mkdtempSync(join(tmpdir(), "agent-pipeline-remote-"));
  repo = mkdtempSync(join(tmpdir(), "agent-pipeline-repo-"));
  created.push(remote, repo);

  git(remote, "init", "--bare", "--initial-branch=main", ".");
  git(repo, "init", "--initial-branch=main", ".");
  git(repo, "config", "user.email", "pipeline@example.com");
  git(repo, "config", "user.name", "agent-pipeline");
  git(repo, "remote", "add", "origin", remote);
  commit(repo, "README.md", "hello\n", "docs: initial commit (#1)");
  git(repo, "push", "-u", "origin", "main");

  workspace = new GitWorkspace(repo);
});

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("worktrees", () => {
  it("creates a worktree on a fresh branch from main", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });

    expect(existsSync(join(path, "README.md"))).toBe(true);
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/2-x");
    expect(git(path, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "main"));
  });

  it("removes the worktree and its branch", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    commit(path, "a.txt", "a\n", "feat: a (#2)");

    await workspace.removeWorktree({ path, branch: "agent/2-x" });

    expect(existsSync(path)).toBe(false);
    expect(git(repo, "branch", "--list", "agent/2-x")).toBe("");
  });
});

describe("hasBranch", () => {
  it("says yes about a branch that is checked out in a worktree", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });

    expect(await workspace.hasBranch("agent/2-x")).toBe(true);
  });

  it("says yes about the branch a removed worktree left behind", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    // `git worktree remove` without the `git branch -D` that follows it here:
    // how a human cleans up after finishing a handed-off Ticket by hand.
    git(repo, "worktree", "remove", "--force", path);

    expect(existsSync(path)).toBe(false);
    expect(await workspace.hasBranch("agent/2-x")).toBe(true);
  });

  it("says no about a branch nothing has created", async () => {
    expect(await workspace.hasBranch("agent/2-x")).toBe(false);
  });

  it("says no once the branch has been deleted with its worktree", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    await workspace.removeWorktree({ path, branch: "agent/2-x" });

    expect(await workspace.hasBranch("agent/2-x")).toBe(false);
  });

  it("says no about a branch that exists only on the remote", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    await workspace.push(path, "agent/2-x");
    await workspace.removeWorktree({ path, branch: "agent/2-x" });

    expect(git(repo, "rev-parse", "--verify", "refs/remotes/origin/agent/2-x")).not.toBe("");
    expect(await workspace.hasBranch("agent/2-x")).toBe(false);
  });

  it("does not mistake a tag of the same name for a branch", async () => {
    git(repo, "tag", "agent/2-x");

    expect(await workspace.hasBranch("agent/2-x")).toBe(false);
  });
});

describe("hasWorktree", () => {
  it("recognises the worktree it created, on the branch it created it on", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });

    expect(await workspace.hasWorktree({ path, branch: "agent/2-x" })).toBe(true);
  });

  it("says no about a Ticket that never had one", async () => {
    const path = join(repo, ".worktrees", "ticket-2");

    expect(await workspace.hasWorktree({ path, branch: "agent/2-x" })).toBe(false);
  });

  it("says no once the worktree has been removed", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    await workspace.removeWorktree({ path, branch: "agent/2-x" });

    expect(await workspace.hasWorktree({ path, branch: "agent/2-x" })).toBe(false);
  });

  it("says no about a directory a human deleted but git still lists", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    // `rm -rf .worktrees` without a prune, which is how a human cleans up.
    rmSync(path, { recursive: true, force: true });

    expect(git(repo, "worktree", "list", "--porcelain")).toContain(path);
    expect(await workspace.hasWorktree({ path, branch: "agent/2-x" })).toBe(false);
  });

  it("says no when the worktree is on another branch than the one asked about", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    git(path, "checkout", "-b", "agent/2-something-else");

    expect(await workspace.hasWorktree({ path, branch: "agent/2-x" })).toBe(false);
    expect(await workspace.hasWorktree({ path, branch: "agent/2-something-else" })).toBe(true);
  });

  it("tells one Ticket's worktree from another's", async () => {
    const mine = join(repo, ".worktrees", "ticket-2");
    const theirs = join(repo, ".worktrees", "ticket-3");
    await workspace.createWorktree({ path: mine, branch: "agent/2-x" });
    await workspace.createWorktree({ path: theirs, branch: "agent/3-y" });

    expect(await workspace.hasWorktree({ path: mine, branch: "agent/3-y" })).toBe(false);
    expect(await workspace.hasWorktree({ path: theirs, branch: "agent/3-y" })).toBe(true);
  });
});

describe("commitSubjects", () => {
  it("reads only the commits main does not have, oldest first", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });

    expect(await workspace.commitSubjects("agent/2-x")).toEqual([]);

    commit(path, "a.txt", "a\n", "feat: a (#2)");
    commit(path, "b.txt", "b\n", "test: b (#2)");
    commit(path, "c.txt", "c\n", "docs: c (#2)");

    // Not main's own "docs: initial commit (#1)", and not git's newest-first order.
    expect(await workspace.commitSubjects("agent/2-x")).toEqual([
      "feat: a (#2)",
      "test: b (#2)",
      "docs: c (#2)",
    ]);
  });

  it("collects each co-author once, in the order first seen, ignoring the key's case", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    commit(path, "a.txt", "a\n", "feat: a (#2)\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>");
    commit(path, "b.txt", "b\n", "test: b (#2)\n\nCo-authored-by: Pat <pat@example.com>\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>");
    commit(path, "c.txt", "c\n", "docs: c (#2)");

    expect(await workspace.coAuthors("agent/2-x")).toEqual([
      "Claude Opus 5 <noreply@anthropic.com>",
      "Pat <pat@example.com>",
    ]);
  });

  it("keeps a commit whose subject is empty, so the order does not shift", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    writeFileSync(join(path, "a.txt"), "a\n");
    git(path, "add", "-A");
    git(path, "commit", "--allow-empty-message", "-m", "");
    commit(path, "b.txt", "b\n", "feat: b (#2)");

    expect(await workspace.commitSubjects("agent/2-x")).toEqual(["", "feat: b (#2)"]);
  });

  it("reads the subject only, never the body", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    writeFileSync(join(path, "a.txt"), "a\n");
    git(path, "add", "-A");
    git(path, "commit", "-m", "feat: a (#2)", "-m", "A body\n\nwith blank lines.");

    expect(await workspace.commitSubjects("agent/2-x")).toEqual(["feat: a (#2)"]);
  });
});

describe("runCheck", () => {
  /** Long enough that nothing here reaches it by running slowly. */
  const LIMIT_MS = 30_000;

  it("reports a passing command with its output", async () => {
    const result = await workspace.runCheck("echo hello", repo, LIMIT_MS);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("reports a failing command and captures stderr", async () => {
    const result = await workspace.runCheck("echo boom >&2; exit 3", repo, LIMIT_MS);

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBeFalsy();
    expect(result.output).toContain("boom");
  });

  it("runs the command in the directory it is given", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });

    const result = await workspace.runCheck("pwd", path, LIMIT_MS);

    expect(result.output).toContain("ticket-2");
  });

  it("kills a command that outlives the limit and keeps what it printed", async () => {
    const startedAt = Date.now();

    const result = await workspace.runCheck("echo starting; sleep 30", repo, 300);

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.output).toContain("starting");
    // The point of the limit: the call settles on its own clock rather than on
    // the command's, which here would have been a hundred times longer.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe("discardChanges", () => {
  it("restores tracked files and deletes scratch files", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    writeFileSync(join(path, "README.md"), "vandalised\n");
    writeFileSync(join(path, "scratch.test.ts"), "throwaway\n");

    await workspace.discardChanges(path);

    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("hello\n");
    expect(existsSync(join(path, "scratch.test.ts"))).toBe(false);
  });

  it("leaves gitignored files alone", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    writeFileSync(join(path, ".gitignore"), "keep.txt\n");
    git(path, "add", "-A");
    git(path, "commit", "-m", "chore: ignore keep.txt (#2)");
    writeFileSync(join(path, "keep.txt"), "kept\n");

    await workspace.discardChanges(path);

    expect(existsSync(join(path, "keep.txt"))).toBe(true);
  });
});

describe("rebaseOnMain", () => {
  it("replays the branch onto a main that moved on", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    commit(repo, "main.txt", "main\n", "feat: main moved (#1)");

    const result = await workspace.rebaseOnMain(path);

    expect(result.ok).toBe(true);
    expect(existsSync(join(path, "main.txt"))).toBe(true);
    expect(await workspace.commitSubjects("agent/2-x")).toEqual(["feat: a (#2)"]);
  });

  it("reports a conflict and leaves the rebase in progress to be resolved", async () => {
    const path = conflictingWorktree();

    const result = await workspace.rebaseOnMain(path);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a conflict");
    expect(result.conflict).toContain("README.md");
    expect(git(path, "status", "--porcelain")).toContain("UU README.md");
    expect(readFileSync(join(path, "README.md"), "utf8")).toContain("branch version");
  });

  it("puts the worktree back when the rebase is aborted", async () => {
    const path = conflictingWorktree();
    await workspace.rebaseOnMain(path);

    await workspace.abortRebase(path);

    expect(git(path, "status", "--porcelain")).toBe("");
    expect(await workspace.rebaseState(path)).toEqual({
      resolved: false,
      unresolved: "the branch is not rebased onto main",
    });
  });

  it("is happy to abort when no rebase is in progress", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });

    await expect(workspace.abortRebase(path)).resolves.toBeUndefined();
  });
});

describe("rebaseState", () => {
  it("calls a rebase that replayed every commit resolved", async () => {
    const path = conflictingWorktree();
    await workspace.rebaseOnMain(path);

    writeFileSync(join(path, "README.md"), "both versions\n");
    git(path, "add", "-A");
    git(path, "-c", "core.editor=true", "rebase", "--continue");

    expect(await workspace.rebaseState(path)).toEqual({ resolved: true });
  });

  it("reports the rebase git is still in the middle of, and what is unmerged", async () => {
    const path = conflictingWorktree();
    await workspace.rebaseOnMain(path);

    const state = await workspace.rebaseState(path);

    expect(state.resolved).toBe(false);
    if (state.resolved) throw new Error("expected an unresolved rebase");
    expect(state.unresolved).toContain("a rebase is still in progress");
    expect(state.unresolved).toContain("unmerged paths: README.md");
    expect(state.unresolved).toContain("conflict markers left in: README.md");
  });

  it("reports a rebase that was abandoned rather than finished", async () => {
    const path = conflictingWorktree();
    await workspace.rebaseOnMain(path);

    git(path, "rebase", "--abort");

    expect(await workspace.rebaseState(path)).toEqual({
      resolved: false,
      unresolved: "the branch is not rebased onto main",
    });
  });

  it("reports conflict markers committed into a finished rebase", async () => {
    const path = conflictingWorktree();
    await workspace.rebaseOnMain(path);

    // What a careless resolution looks like: the rebase finishes, the markers
    // git wrote into the file are committed along with it.
    git(path, "add", "-A");
    git(path, "-c", "core.editor=true", "rebase", "--continue");

    const state = await workspace.rebaseState(path);

    expect(state.resolved).toBe(false);
    if (state.resolved) throw new Error("expected unresolved conflict markers");
    expect(state.unresolved).toBe("conflict markers left in: README.md");
  });

  it("sees a marker in a file nobody staged", async () => {
    const path = conflictingWorktree();
    await workspace.rebaseOnMain(path);
    writeFileSync(join(path, "README.md"), "both versions\n");
    git(path, "add", "-A");
    git(path, "-c", "core.editor=true", "rebase", "--continue");
    // Scratch the session wrote by hand and never staged.
    writeFileSync(join(path, "notes.md"), `${"<".repeat(7)} HEAD\nmine\n`);

    const state = await workspace.rebaseState(path);

    expect(state.resolved).toBe(false);
    if (state.resolved) throw new Error("expected an unresolved marker");
    expect(state.unresolved).toBe("conflict markers left in: notes.md");
  });

  it("refuses a conflict that was merged in rather than rebased away", async () => {
    const path = conflictingWorktree();
    await workspace.rebaseOnMain(path);
    await workspace.abortRebase(path);

    git(path, "-c", "core.editor=true", "merge", "main", "--strategy-option=ours");

    const state = await workspace.rebaseState(path);

    expect(state.resolved).toBe(false);
    if (state.resolved) throw new Error("expected the merge to be refused");
    expect(state.unresolved).toContain("merged into the branch, not rebased");
  });

  it("does not mistake a marker quoted mid-line for a conflict", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    const quoted = `const marker = "${"<".repeat(7)} HEAD";\n`;
    commit(path, "markers.ts", quoted, "feat: quote a marker (#2)");

    expect(await workspace.rebaseState(path)).toEqual({ resolved: true });
  });
});

describe("push and pullMain", () => {
  it("pushes the branch to the remote", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    commit(path, "a.txt", "a\n", "feat: a (#2)");

    await workspace.push(path, "agent/2-x");

    expect(git(remote, "rev-parse", "agent/2-x")).toBe(git(path, "rev-parse", "HEAD"));
  });

  it("deletes the branch on the remote", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    await workspace.push(path, "agent/2-x");

    await workspace.deleteRemoteBranch("agent/2-x");

    expect(git(remote, "branch", "--list", "agent/2-x")).toBe("");
  });

  it("force-pushes after a rebase rewrote the branch", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    await workspace.push(path, "agent/2-x");

    commit(repo, "main.txt", "main\n", "feat: main moved (#1)");
    await workspace.rebaseOnMain(path);
    await workspace.push(path, "agent/2-x");

    expect(git(remote, "rev-parse", "agent/2-x")).toBe(git(path, "rev-parse", "HEAD"));
  });

  it("advances the local main ref while another branch is checked out", async () => {
    const other = mkdtempSync(join(tmpdir(), "agent-pipeline-other-"));
    created.push(other);
    git(other, "clone", remote, ".");
    git(other, "config", "user.email", "human@example.com");
    git(other, "config", "user.name", "human");
    commit(other, "from-elsewhere.txt", "x\n", "feat: elsewhere (#1)");
    git(other, "push", "origin", "main");

    git(repo, "checkout", "-b", "human/2-skeleton");
    await workspace.pullMain();

    expect(git(repo, "rev-parse", "main")).toBe(git(other, "rev-parse", "HEAD"));
  });

  it("fast-forwards main when main is the branch checked out", async () => {
    const other = mkdtempSync(join(tmpdir(), "agent-pipeline-other-"));
    created.push(other);
    git(other, "clone", remote, ".");
    git(other, "config", "user.email", "human@example.com");
    git(other, "config", "user.name", "human");
    commit(other, "from-elsewhere.txt", "x\n", "feat: elsewhere (#1)");
    git(other, "push", "origin", "main");

    await workspace.pullMain();

    expect(git(repo, "rev-parse", "HEAD")).toBe(git(other, "rev-parse", "HEAD"));
  });
});
