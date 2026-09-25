import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Host } from "../host.js";
import { LOCK_BRANCH, LOCK_FILE, lockFileContents, readLockFile } from "../lock.js";
import type { LockHolder } from "../ports/workspace.js";
import { stageLogDir, writeRunVersion } from "../run-log.js";
import { GitWorkspace, STATE_BRANCH } from "./git-workspace.js";

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

/**
 * A bare remote and a checkout of it, both starting on `base`, with one commit
 * pushed. The branch name is a parameter because nothing in the workspace is
 * allowed to assume `main`.
 */
function setUpRepo(base: string): { remote: string; repo: string } {
  const remote = mkdtempSync(join(tmpdir(), "agent-pipeline-remote-"));
  const repo = mkdtempSync(join(tmpdir(), "agent-pipeline-repo-"));
  created.push(remote, repo);

  git(remote, "init", "--bare", `--initial-branch=${base}`, ".");
  git(repo, "init", `--initial-branch=${base}`, ".");
  git(repo, "config", "user.email", "pipeline@example.com");
  git(repo, "config", "user.name", "agent-pipeline");
  git(repo, "remote", "add", "origin", remote);
  commit(repo, "README.md", "hello\n", "docs: initial commit (#1)");
  git(repo, "push", "-u", "origin", base);
  return { remote, repo };
}

beforeEach(() => {
  ({ remote, repo } = setUpRepo("main"));
  workspace = new GitWorkspace(repo);
});

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("worktrees", () => {
  it("creates a worktree on a fresh branch from main", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");

    expect(existsSync(join(path, "README.md"))).toBe(true);
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/2-x");
    expect(git(path, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "main"));
  });

  it("removes the worktree and its branch", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)");

    await workspace.removeWorktree({ path, branch: "agent/2-x" });

    expect(existsSync(path)).toBe(false);
    expect(git(repo, "branch", "--list", "agent/2-x")).toBe("");
  });
});

describe("hasBranch", () => {
  it("says yes about a branch that is checked out in a worktree", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");

    expect(await workspace.hasBranch("agent/2-x")).toBe(true);
  });

  it("says yes about the branch a removed worktree left behind", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
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
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    await workspace.removeWorktree({ path, branch: "agent/2-x" });

    expect(await workspace.hasBranch("agent/2-x")).toBe(false);
  });

  it("says no about a branch that exists only on the remote", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
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
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");

    expect(await workspace.hasWorktree({ path, branch: "agent/2-x" })).toBe(true);
  });

  it("says no about a Ticket that never had one", async () => {
    const path = join(repo, ".worktrees", "ticket-2");

    expect(await workspace.hasWorktree({ path, branch: "agent/2-x" })).toBe(false);
  });

  it("says no once the worktree has been removed", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    await workspace.removeWorktree({ path, branch: "agent/2-x" });

    expect(await workspace.hasWorktree({ path, branch: "agent/2-x" })).toBe(false);
  });

  it("says no about a directory a human deleted but git still lists", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    // `rm -rf .worktrees` without a prune, which is how a human cleans up.
    rmSync(path, { recursive: true, force: true });

    expect(git(repo, "worktree", "list", "--porcelain")).toContain(path);
    expect(await workspace.hasWorktree({ path, branch: "agent/2-x" })).toBe(false);
  });

  it("says no when the worktree is on another branch than the one asked about", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    git(path, "checkout", "-b", "agent/2-something-else");

    expect(await workspace.hasWorktree({ path, branch: "agent/2-x" })).toBe(false);
    expect(await workspace.hasWorktree({ path, branch: "agent/2-something-else" })).toBe(true);
  });

  it("tells one Ticket's worktree from another's", async () => {
    const mine = join(repo, ".worktrees", "ticket-2");
    const theirs = join(repo, ".worktrees", "ticket-3");
    await workspace.createWorktree({ path: mine, branch: "agent/2-x" }, "main");
    await workspace.createWorktree({ path: theirs, branch: "agent/3-y" }, "main");

    expect(await workspace.hasWorktree({ path: mine, branch: "agent/3-y" })).toBe(false);
    expect(await workspace.hasWorktree({ path: theirs, branch: "agent/3-y" })).toBe(true);
  });
});

describe("commitSubjects", () => {
  it("reads only the commits main does not have, oldest first", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");

    expect(await workspace.commitSubjects("agent/2-x", "main")).toEqual([]);

    commit(path, "a.txt", "a\n", "feat: a (#2)");
    commit(path, "b.txt", "b\n", "test: b (#2)");
    commit(path, "c.txt", "c\n", "docs: c (#2)");

    // Not main's own "docs: initial commit (#1)", and not git's newest-first order.
    expect(await workspace.commitSubjects("agent/2-x", "main")).toEqual([
      "feat: a (#2)",
      "test: b (#2)",
      "docs: c (#2)",
    ]);
  });

  it("collects each co-author once, in the order first seen, ignoring the key's case", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>");
    commit(path, "b.txt", "b\n", "test: b (#2)\n\nCo-authored-by: Pat <pat@example.com>\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>");
    commit(path, "c.txt", "c\n", "docs: c (#2)");

    expect(await workspace.coAuthors("agent/2-x", "main")).toEqual([
      "Claude Opus 5 <noreply@anthropic.com>",
      "Pat <pat@example.com>",
    ]);
  });

  it("keeps a commit whose subject is empty, so the order does not shift", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    writeFileSync(join(path, "a.txt"), "a\n");
    git(path, "add", "-A");
    git(path, "commit", "--allow-empty-message", "-m", "");
    commit(path, "b.txt", "b\n", "feat: b (#2)");

    expect(await workspace.commitSubjects("agent/2-x", "main")).toEqual(["", "feat: b (#2)"]);
  });

  it("reads the subject only, never the body", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    writeFileSync(join(path, "a.txt"), "a\n");
    git(path, "add", "-A");
    git(path, "commit", "-m", "feat: a (#2)", "-m", "A body\n\nwith blank lines.");

    expect(await workspace.commitSubjects("agent/2-x", "main")).toEqual(["feat: a (#2)"]);
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

    expect(result).toMatchObject({ ok: false, timedOut: false });
    expect(result.output).toContain("boom");
  });

  it("runs the command in the directory it is given", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");

    const result = await workspace.runCheck("pwd", path, LIMIT_MS);

    expect(result.output).toContain("ticket-2");
  });

  it("kills a command that outlives the limit and keeps what it printed", async () => {
    const startedAt = Date.now();

    const result = await workspace.runCheck("echo starting; sleep 30", repo, 300);

    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(result.output).toContain("starting");
    // The point of the limit: the call settles on its own clock rather than on
    // the command's, which here would have been a hundred times longer.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("discardChanges", () => {
  it("restores tracked files and deletes scratch files", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    writeFileSync(join(path, "README.md"), "vandalised\n");
    writeFileSync(join(path, "scratch.test.ts"), "throwaway\n");

    await workspace.discardChanges(path);

    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("hello\n");
    expect(existsSync(join(path, "scratch.test.ts"))).toBe(false);
  });

  it("leaves gitignored files alone", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    writeFileSync(join(path, ".gitignore"), "keep.txt\n");
    git(path, "add", "-A");
    git(path, "commit", "-m", "chore: ignore keep.txt (#2)");
    writeFileSync(join(path, "keep.txt"), "kept\n");

    await workspace.discardChanges(path);

    expect(existsSync(join(path, "keep.txt"))).toBe(true);
  });
});

describe("uncommittedPaths", () => {
  let path: string;

  beforeEach(async () => {
    path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
  });

  it("finds nothing in a worktree whose every change is committed", async () => {
    commit(path, "a.txt", "a\n", "feat: a (#2)");

    expect(await workspace.uncommittedPaths(path)).toEqual([]);
  });

  it("names a tracked file that was modified, staged or not", async () => {
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    writeFileSync(join(path, "README.md"), "edited\n");
    writeFileSync(join(path, "a.txt"), "staged\n");
    git(path, "add", "a.txt");

    expect((await workspace.uncommittedPaths(path)).sort()).toEqual(["README.md", "a.txt"]);
  });

  it("names an untracked file git does not ignore, and not one it does", async () => {
    commit(path, ".gitignore", "build/\n", "chore: ignore build (#2)");
    mkdirSync(join(path, "build"));
    writeFileSync(join(path, "build", "out.js"), "ignored\n");
    writeFileSync(join(path, "new file.ts"), "untracked\n");

    expect(await workspace.uncommittedPaths(path)).toEqual(["new file.ts"]);
  });

  it("names an untracked file even where git is configured to hide untracked files", async () => {
    git(path, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(path, "new file.ts"), "untracked\n");

    expect(await workspace.uncommittedPaths(path)).toEqual(["new file.ts"]);
  });

  it("names a renamed file by where it went", async () => {
    git(path, "mv", "README.md", "READ.md");

    expect(await workspace.uncommittedPaths(path)).toEqual(["READ.md"]);
  });
});

describe("rebase", () => {
  it("replays the branch onto a main that moved on", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    commit(repo, "main.txt", "main\n", "feat: main moved (#1)");

    const result = await workspace.rebase(path, "main");

    expect(result.ok).toBe(true);
    expect(existsSync(join(path, "main.txt"))).toBe(true);
    expect(await workspace.commitSubjects("agent/2-x", "main")).toEqual(["feat: a (#2)"]);
  });

  it("reports a conflict and leaves the rebase in progress to be resolved", async () => {
    const path = conflictingWorktree();

    const result = await workspace.rebase(path, "main");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a conflict");
    expect(result.conflict).toContain("README.md");
    expect(git(path, "status", "--porcelain")).toContain("UU README.md");
    expect(readFileSync(join(path, "README.md"), "utf8")).toContain("branch version");
  });

  it("puts the worktree back when the rebase is aborted", async () => {
    const path = conflictingWorktree();
    await workspace.rebase(path, "main");

    await workspace.abortRebase(path);

    expect(git(path, "status", "--porcelain")).toBe("");
    expect(await workspace.rebaseState(path, "main")).toEqual({
      resolved: false,
      unresolved: "the branch is not rebased onto main",
    });
  });

  it("is happy to abort when no rebase is in progress", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");

    await expect(workspace.abortRebase(path)).resolves.toBeUndefined();
  });
});

describe("rebaseState", () => {
  it("calls a rebase that replayed every commit resolved", async () => {
    const path = conflictingWorktree();
    await workspace.rebase(path, "main");

    writeFileSync(join(path, "README.md"), "both versions\n");
    git(path, "add", "-A");
    git(path, "-c", "core.editor=true", "rebase", "--continue");

    expect(await workspace.rebaseState(path, "main")).toEqual({ resolved: true });
  });

  it("reports the rebase git is still in the middle of, and what is unmerged", async () => {
    const path = conflictingWorktree();
    await workspace.rebase(path, "main");

    const state = await workspace.rebaseState(path, "main");

    expect(state.resolved).toBe(false);
    if (state.resolved) throw new Error("expected an unresolved rebase");
    expect(state.unresolved).toContain("a rebase is still in progress");
    expect(state.unresolved).toContain("unmerged paths: README.md");
    expect(state.unresolved).toContain("conflict markers left in: README.md");
  });

  it("reports a rebase that was abandoned rather than finished", async () => {
    const path = conflictingWorktree();
    await workspace.rebase(path, "main");

    git(path, "rebase", "--abort");

    expect(await workspace.rebaseState(path, "main")).toEqual({
      resolved: false,
      unresolved: "the branch is not rebased onto main",
    });
  });

  it("reports conflict markers committed into a finished rebase", async () => {
    const path = conflictingWorktree();
    await workspace.rebase(path, "main");

    // What a careless resolution looks like: the rebase finishes, the markers
    // git wrote into the file are committed along with it.
    git(path, "add", "-A");
    git(path, "-c", "core.editor=true", "rebase", "--continue");

    const state = await workspace.rebaseState(path, "main");

    expect(state.resolved).toBe(false);
    if (state.resolved) throw new Error("expected unresolved conflict markers");
    expect(state.unresolved).toBe("conflict markers left in: README.md");
  });

  it("sees a marker in a file nobody staged", async () => {
    const path = conflictingWorktree();
    await workspace.rebase(path, "main");
    writeFileSync(join(path, "README.md"), "both versions\n");
    git(path, "add", "-A");
    git(path, "-c", "core.editor=true", "rebase", "--continue");
    // Scratch the session wrote by hand and never staged.
    writeFileSync(join(path, "notes.md"), `${"<".repeat(7)} HEAD\nmine\n`);

    const state = await workspace.rebaseState(path, "main");

    expect(state.resolved).toBe(false);
    if (state.resolved) throw new Error("expected an unresolved marker");
    expect(state.unresolved).toBe("conflict markers left in: notes.md");
  });

  it("refuses a conflict that was merged in rather than rebased away", async () => {
    const path = conflictingWorktree();
    await workspace.rebase(path, "main");
    await workspace.abortRebase(path);

    git(path, "-c", "core.editor=true", "merge", "main", "--strategy-option=ours");

    const state = await workspace.rebaseState(path, "main");

    expect(state.resolved).toBe(false);
    if (state.resolved) throw new Error("expected the merge to be refused");
    expect(state.unresolved).toContain("merged into the branch, not rebased");
  });

  it("does not mistake a marker quoted mid-line for a conflict", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    const quoted = `const marker = "${"<".repeat(7)} HEAD";\n`;
    commit(path, "markers.ts", quoted, "feat: quote a marker (#2)");

    expect(await workspace.rebaseState(path, "main")).toEqual({ resolved: true });
  });
});

describe("push and pullBase", () => {
  it("pushes the branch to the remote", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)");

    await workspace.push(path, "agent/2-x");

    expect(git(remote, "rev-parse", "agent/2-x")).toBe(git(path, "rev-parse", "HEAD"));
  });

  it("deletes the branch on the remote", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    await workspace.push(path, "agent/2-x");

    await workspace.deleteRemoteBranch("agent/2-x");

    expect(git(remote, "branch", "--list", "agent/2-x")).toBe("");
  });

  it("treats a branch the remote already deleted as deleted", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    await workspace.push(path, "agent/2-x");
    // As GitHub does the moment a PR merges when the repo is set to.
    git(remote, "branch", "-D", "agent/2-x");

    await expect(workspace.deleteRemoteBranch("agent/2-x")).resolves.toBeUndefined();

    expect(git(remote, "branch", "--list", "agent/2-x")).toBe("");
  });

  it("asks for no delete of a branch the remote already deleted, as a cloud Host could send none", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    await workspace.push(path, "agent/2-x");
    git(remote, "branch", "-D", "agent/2-x");
    // Every push now fails, whatever git would have said about the ref: the
    // cloud proxy refuses a delete before a remote can answer it.
    git(repo, "remote", "set-url", "--push", "origin", join(remote, "missing"));

    await expect(workspace.deleteRemoteBranch("agent/2-x")).resolves.toBeUndefined();
  });

  it("still fails when the remote refuses the delete", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    await workspace.push(path, "agent/2-x");
    // A remote that has gone away fails the push before any ref is looked at.
    git(repo, "remote", "set-url", "origin", join(remote, "missing"));

    await expect(workspace.deleteRemoteBranch("agent/2-x")).rejects.toThrow(/exited/);
  });

  it("force-pushes after a rebase rewrote the branch", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    await workspace.push(path, "agent/2-x");

    commit(repo, "main.txt", "main\n", "feat: main moved (#1)");
    await workspace.rebase(path, "main");
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
    await workspace.pullBase("main");

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

    await workspace.pullBase("main");

    expect(git(repo, "rev-parse", "HEAD")).toBe(git(other, "rev-parse", "HEAD"));
  });
});

/**
 * Where a resumed Ticket's worktree comes from once its branch lives on the
 * remote: another Host is a second clone of the same bare remote, pushing the
 * work this checkout's Run is about to resume.
 */
describe("a worktree from the remote branch", () => {
  const branch = "agent/2-x";
  let path: string;

  beforeEach(() => {
    path = join(repo, ".worktrees", "ticket-2");
  });

  /** A second Host: its own clone of the remote, with the Ticket's branch on it. */
  function otherHost(): string {
    const clone = mkdtempSync(join(tmpdir(), "agent-pipeline-host-"));
    created.push(clone);
    git(clone, "clone", remote, ".");
    git(clone, "config", "user.email", "pipeline@example.com");
    git(clone, "config", "user.name", "agent-pipeline");
    return clone;
  }

  /** Commit on the other Host's copy of the branch and push it, as a Stage there does. */
  function pushFrom(clone: string, file: string, message: string): void {
    const branches = git(clone, "branch", "--list", branch);
    if (branches === "") {
      const onRemote = git(clone, "ls-remote", "--heads", "origin", branch) !== "";
      if (onRemote) {
        git(clone, "fetch", "origin", branch);
        git(clone, "checkout", "-b", branch, "FETCH_HEAD");
      } else {
        git(clone, "checkout", "-b", branch);
      }
    }
    commit(clone, file, `${file}\n`, message);
    git(clone, "push", "--force", "origin", branch);
  }

  it("makes one from the remote branch when this Host has none", async () => {
    const other = otherHost();
    pushFrom(other, "a.txt", "feat: a (#2)");

    expect(await workspace.worktreeFromRemote({ path, branch })).toBe("made");

    expect(await workspace.hasWorktree({ path, branch })).toBe(true);
    expect(git(path, "rev-parse", "HEAD")).toBe(git(other, "rev-parse", "HEAD"));
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("a.txt\n");
  });

  it("makes one a later push from it lands on, as the Stages that resume there push", async () => {
    const other = otherHost();
    pushFrom(other, "a.txt", "feat: a (#2)");
    await workspace.worktreeFromRemote({ path, branch });

    commit(path, "b.txt", "b\n", "feat: b (#2)");
    await workspace.push(path, branch);

    expect(git(remote, "rev-parse", branch)).toBe(git(path, "rev-parse", "HEAD"));
  });

  it("says the branch is gone when neither this Host nor the remote has it", async () => {
    expect(await workspace.worktreeFromRemote({ path, branch })).toBe("gone");

    expect(existsSync(path)).toBe(false);
    expect(await workspace.hasBranch(branch)).toBe(false);
  });

  it("keeps a worktree that sits on top of the remote branch, unpushed commits and all", async () => {
    await workspace.createWorktree({ path, branch }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    await workspace.push(path, branch);
    // What a Run on this Host committed and died before pushing.
    commit(path, "b.txt", "b\n", "feat: b (#2)");
    const tip = git(path, "rev-parse", "HEAD");

    expect(await workspace.worktreeFromRemote({ path, branch })).toBe("kept");

    expect(git(path, "rev-parse", "HEAD")).toBe(tip);
    expect(git(remote, "rev-parse", branch)).not.toBe(tip);
  });

  it("keeps a worktree whose branch never reached the remote", async () => {
    await workspace.createWorktree({ path, branch }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    const tip = git(path, "rev-parse", "HEAD");

    expect(await workspace.worktreeFromRemote({ path, branch })).toBe("kept");

    expect(git(path, "rev-parse", "HEAD")).toBe(tip);
  });

  it("brings a worktree up to a remote branch another Host moved on", async () => {
    await workspace.createWorktree({ path, branch }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    await workspace.push(path, branch);
    const other = otherHost();
    pushFrom(other, "b.txt", "fix: b (#2)");

    expect(await workspace.worktreeFromRemote({ path, branch })).toBe("kept");

    expect(git(path, "rev-parse", "HEAD")).toBe(git(other, "rev-parse", "HEAD"));
    expect(await workspace.uncommittedPaths(path)).toEqual([]);
  });

  it("keeps a worktree a Run left mid-rebase, back on its branch", async () => {
    await workspace.createWorktree({ path, branch }, "main");
    commit(path, "README.md", "branch version\n", "feat: branch edit (#2)");
    await workspace.push(path, branch);
    const tip = git(path, "rev-parse", "HEAD");
    commit(repo, "README.md", "main version\n", "feat: main edit (#1)");
    expect(await workspace.rebase(path, "main")).toMatchObject({ ok: false });

    expect(await workspace.worktreeFromRemote({ path, branch })).toBe("kept");

    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    expect(git(path, "rev-parse", "HEAD")).toBe(tip);
  });

  it("keeps a worktree this Host rebased and never pushed, and the push then lands", async () => {
    await workspace.createWorktree({ path, branch }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    await workspace.push(path, branch);
    commit(repo, "main.txt", "main\n", "feat: main moved (#1)");
    await workspace.rebase(path, "main");
    const rebased = git(path, "rev-parse", "HEAD");

    expect(await workspace.worktreeFromRemote({ path, branch })).toBe("kept");

    expect(git(path, "rev-parse", "HEAD")).toBe(rebased);
    await workspace.push(path, branch);
    expect(git(remote, "rev-parse", branch)).toBe(rebased);
  });

  it("forgets a remote branch that has gone, so the next push is not refused over it", async () => {
    await workspace.createWorktree({ path, branch }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    await workspace.push(path, branch);
    git(remote, "branch", "-D", branch);
    commit(path, "b.txt", "b\n", "feat: b (#2)");

    expect(await workspace.worktreeFromRemote({ path, branch })).toBe("kept");

    await workspace.push(path, branch);
    expect(git(remote, "rev-parse", branch)).toBe(git(path, "rev-parse", "HEAD"));
  });

  it("reports a worktree that has parted from the remote branch, and leaves both alone", async () => {
    await workspace.createWorktree({ path, branch }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    await workspace.push(path, branch);
    const other = otherHost();
    pushFrom(other, "b.txt", "fix: b (#2)");
    commit(path, "c.txt", "c\n", "fix: c (#2)");
    const mine = git(path, "rev-parse", "HEAD");
    const theirs = git(remote, "rev-parse", branch);

    expect(await workspace.worktreeFromRemote({ path, branch })).toBe("parted");

    expect(git(path, "rev-parse", "HEAD")).toBe(mine);
    expect(git(remote, "rev-parse", branch)).toBe(theirs);
  });

  it("reports a branch left without its worktree that has parted from the remote one", async () => {
    await workspace.createWorktree({ path, branch }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    await workspace.push(path, branch);
    commit(path, "c.txt", "c\n", "fix: c (#2)");
    git(repo, "worktree", "remove", "--force", path);
    pushFrom(otherHost(), "b.txt", "fix: b (#2)");

    expect(await workspace.worktreeFromRemote({ path, branch })).toBe("parted");

    expect(existsSync(path)).toBe(false);
  });

  it("puts a worktree back on a branch it left behind that contains the remote one", async () => {
    await workspace.createWorktree({ path, branch }, "main");
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    await workspace.push(path, branch);
    commit(path, "b.txt", "b\n", "feat: b (#2)");
    const tip = git(path, "rev-parse", "HEAD");
    // `rm -rf .worktrees` without a prune, which is how a human cleans up.
    rmSync(path, { recursive: true, force: true });

    expect(await workspace.worktreeFromRemote({ path, branch })).toBe("made");

    expect(git(path, "rev-parse", "HEAD")).toBe(tip);
  });
});

/**
 * What the Tickets of one Run do to the main checkout when they are not taking
 * turns: git fails a second `worktree add` or `fetch` outright rather than
 * waiting for the lock the first one holds, so the workspace queues them.
 */
describe("two Tickets at the main checkout at once", () => {
  /** A commit pushed to the remote from elsewhere, as another Run's merge is. */
  function moveMainOnTheRemote(): string {
    const other = mkdtempSync(join(tmpdir(), "agent-pipeline-other-"));
    created.push(other);
    git(other, "clone", remote, ".");
    git(other, "config", "user.email", "human@example.com");
    git(other, "config", "user.name", "human");
    commit(other, "from-elsewhere.txt", "x\n", "feat: elsewhere (#1)");
    git(other, "push", "origin", "main");
    return git(other, "rev-parse", "HEAD");
  }

  it("pulls the base branch several times at once without losing a ref lock", async () => {
    const moved = moveMainOnTheRemote();

    // The one command two Tickets really do ask for together, and the one git
    // refuses outright rather than waiting for: they all move the same ref.
    await Promise.all([1, 2, 3, 4, 5, 6].map(() => workspace.pullBase("main")));

    expect(git(repo, "rev-parse", "main")).toBe(moved);
  });

  it("creates every worktree asked for at once", async () => {
    const tickets = [2, 3, 4];
    const paths = tickets.map((ticket) => join(repo, ".worktrees", `ticket-${ticket}`));

    await Promise.all(
      tickets.map((ticket, index) =>
        workspace.createWorktree(
          { path: paths[index] as string, branch: `agent/${ticket}-x` },
          "main",
        ),
      ),
    );

    for (const [index, ticket] of tickets.entries()) {
      const path = paths[index] as string;
      expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`agent/${ticket}-x`);
      expect(git(path, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "main"));
    }
  });

  it("pulls the base branch while another Ticket's worktree is removed", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    const moved = moveMainOnTheRemote();

    await Promise.all([
      workspace.pullBase("main"),
      workspace.removeWorktree({ path, branch: "agent/2-x" }),
    ]);

    expect(git(repo, "rev-parse", "main")).toBe(moved);
    expect(existsSync(path)).toBe(false);
    expect(await workspace.hasBranch("agent/2-x")).toBe(false);
  });

  it("carries on with the next command after one of them fails", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    // A branch that is already there, which is the failure the pipeline asks
    // about by hand before it ever gets here.
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");

    const taken = workspace.createWorktree(
      { path: join(repo, ".worktrees", "ticket-3"), branch: "agent/2-x" },
      "main",
    );
    const next = workspace.createWorktree(
      { path: join(repo, ".worktrees", "ticket-4"), branch: "agent/4-x" },
      "main",
    );

    await expect(taken).rejects.toThrow();
    await next;

    expect(git(join(repo, ".worktrees", "ticket-4"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "agent/4-x",
    );
  });
});

/**
 * A Target GitHub calls `master`, which is the whole of what the config-free
 * repository on an older default gets: the same worktree, the same rebase and
 * the same pull, against a branch nothing here spells out.
 */
describe("a Target whose base branch is not main", () => {
  const BASE = "master";
  let master: GitWorkspace;
  let masterRemote: string;
  let masterRepo: string;

  beforeEach(() => {
    ({ remote: masterRemote, repo: masterRepo } = setUpRepo(BASE));
    master = new GitWorkspace(masterRepo);
  });

  it("creates the worktree from master, not from a branch called main", async () => {
    const path = join(masterRepo, ".worktrees", "ticket-2");

    await master.createWorktree({ path, branch: "agent/2-x" }, BASE);

    expect(git(path, "rev-parse", "HEAD")).toBe(git(masterRepo, "rev-parse", BASE));
    expect(git(masterRepo, "branch", "--list", "main")).toBe("");
  });

  it("replays the branch onto a master that moved on", async () => {
    const path = join(masterRepo, ".worktrees", "ticket-2");
    await master.createWorktree({ path, branch: "agent/2-x" }, BASE);
    commit(path, "a.txt", "a\n", "feat: a (#2)");
    commit(masterRepo, "master.txt", "master\n", "feat: master moved (#1)");

    const result = await master.rebase(path, BASE);

    expect(result.ok).toBe(true);
    expect(existsSync(join(path, "master.txt"))).toBe(true);
    expect(await master.commitSubjects("agent/2-x", BASE)).toEqual(["feat: a (#2)"]);
    expect(await master.rebaseState(path, BASE)).toEqual({ resolved: true });
  });

  it("pulls master after the merge, while another branch is checked out", async () => {
    const other = mkdtempSync(join(tmpdir(), "agent-pipeline-other-"));
    created.push(other);
    git(other, "clone", masterRemote, ".");
    git(other, "config", "user.email", "human@example.com");
    git(other, "config", "user.name", "human");
    commit(other, "merged.txt", "x\n", "feat: merged elsewhere (#1)");
    git(other, "push", "origin", BASE);
    git(masterRepo, "checkout", "-b", "human/2-x");

    await master.pullBase(BASE);

    expect(git(masterRepo, "rev-parse", BASE)).toBe(git(other, "rev-parse", "HEAD"));
  });

  it("fast-forwards master when master is the branch checked out", async () => {
    const other = mkdtempSync(join(tmpdir(), "agent-pipeline-other-"));
    created.push(other);
    git(other, "clone", masterRemote, ".");
    git(other, "config", "user.email", "human@example.com");
    git(other, "config", "user.name", "human");
    commit(other, "merged.txt", "x\n", "feat: merged elsewhere (#1)");
    git(other, "push", "origin", BASE);

    await master.pullBase(BASE);

    expect(git(masterRepo, "rev-parse", "HEAD")).toBe(git(other, "rev-parse", "HEAD"));
  });
});

describe("the State a Ticket keeps", () => {
  const state = {
    ticket: 4,
    branch: "agent/4-x",
    state: "implemented" as const,
    fixUsed: false,
    runId: "run-0",
    updatedAt: "2026-09-17T09:00:00.000Z",
  };

  /** A second checkout of the same remote, standing for another Host. */
  function anotherHost(): { repo: string; workspace: GitWorkspace } {
    const other = mkdtempSync(join(tmpdir(), "agent-pipeline-host-"));
    created.push(other);
    git(other, "clone", remote, ".");
    git(other, "config", "user.email", "pipeline@example.com");
    git(other, "config", "user.name", "agent-pipeline");
    return { repo: other, workspace: new GitWorkspace(other) };
  }

  /** The files the state branch holds on the remote, by name. */
  function onRemote(): string[] {
    return git(remote, "ls-tree", "--name-only", STATE_BRANCH).split("\n").filter(Boolean);
  }

  /** Commit `files` over the state branch by hand, as a human or an older pipeline might. */
  function commitToStateBranch(files: Record<string, string>): void {
    const { repo: other } = anotherHost();
    git(other, "fetch", "origin", STATE_BRANCH);
    git(other, "checkout", "-b", STATE_BRANCH, "FETCH_HEAD");
    for (const [name, contents] of Object.entries(files)) {
      mkdirSync(join(other, name, ".."), { recursive: true });
      writeFileSync(join(other, name), contents);
    }
    git(other, "add", "-A");
    git(other, "commit", "-m", "by hand");
    git(other, "push", "origin", STATE_BRANCH);
  }

  it("is a file per Ticket on the remote's state branch, readable without the pipeline", async () => {
    await workspace.writeState(state);

    expect(JSON.parse(git(remote, "show", `${STATE_BRANCH}:ticket-4.json`))).toEqual(state);
    expect(await workspace.readState(4)).toEqual(state);
    // Nothing under the run directory any more: that is only this Host's.
    expect(existsSync(join(repo, ".agent-pipeline", "state"))).toBe(false);
  });

  it("is read by a Run on another Host", async () => {
    await workspace.writeState(state);

    expect(await anotherHost().workspace.readState(4)).toEqual(state);
  });

  it("keeps the state branch a single snapshot commit however often it is written", async () => {
    await workspace.writeState({ ...state, state: "claimed" });
    await workspace.writeState(state);
    await workspace.writeState({ ...state, ticket: 9, branch: "agent/9-x" });
    await workspace.removeState(9);
    await workspace.writeState({ ...state, ticket: 9, branch: "agent/9-x" });

    expect(git(remote, "rev-list", "--count", STATE_BRANCH)).toBe("1");
    expect(onRemote()).toEqual(["ticket-4.json", "ticket-9.json"]);
    expect(await workspace.readState(4)).toEqual(state);
  });

  it("keeps what another Host wrote since this one last read it", async () => {
    const other = anotherHost().workspace;
    await workspace.writeState(state);
    await other.writeState({ ...state, ticket: 9, branch: "agent/9-x" });

    await workspace.writeState({ ...state, fixUsed: true });
    await workspace.removeState(5);

    expect(onRemote()).toEqual(["ticket-4.json", "ticket-9.json"]);
    expect(await other.readState(4)).toEqual({ ...state, fixUsed: true });
  });

  it("loses none of the writes a Run's Lanes make at once", async () => {
    const tickets = [3, 4, 5, 6, 7];

    await Promise.all(
      tickets.map((ticket) =>
        workspace.writeState({ ...state, ticket, branch: `agent/${ticket}-x` }),
      ),
    );

    expect((await workspace.readAllStates()).map((file) => file.readable && file.state.ticket)).toEqual(
      tickets,
    );
  });

  it("reads every Ticket's back, lowest first, the unreadable ones included", async () => {
    await workspace.writeState({ ...state, ticket: 9, branch: "agent/9-x" });
    await workspace.writeState(state);
    commitToStateBranch({
      "ticket-6.json": "{ not json",
      // A file that parses, but names another Ticket than its own name does.
      "ticket-7.json": JSON.stringify({ ...state, ticket: 5, version: "0.4.0" }),
      // Neither is a Ticket's State: a note, and a directory of transcripts.
      "notes.txt": "a human's note",
      "ticket-4/implement.jsonl": "{}",
    });

    expect(await workspace.readAllStates()).toEqual([
      { readable: true, state },
      { readable: false, ticket: 6 },
      { readable: false, ticket: 7, version: "0.4.0" },
      { readable: true, state: { ...state, ticket: 9, branch: "agent/9-x" } },
    ]);
    expect(await workspace.readState(6)).toBeUndefined();
    expect(await workspace.readState(7)).toBeUndefined();
  });

  it("keeps what else the state branch holds when a Ticket's State is written", async () => {
    await workspace.writeState(state);
    commitToStateBranch({ "ticket-4/implement.jsonl": "{}" });

    await workspace.writeState({ ...state, fixUsed: true });

    expect(git(remote, "show", `${STATE_BRANCH}:ticket-4/implement.jsonl`)).toBe("{}");
  });

  it("has nothing to read, and creates nothing, before any State is written", async () => {
    expect(await workspace.readState(4)).toBeUndefined();
    expect(await workspace.readAllStates()).toEqual([]);
    await workspace.removeState(4);

    expect(git(remote, "branch", "--list", STATE_BRANCH)).toBe("");
  });

  it("is gone once removed, removing it twice is no error, and the branch stays", async () => {
    await workspace.writeState(state);

    await workspace.removeState(4);
    await workspace.removeState(4);

    expect(await workspace.readState(4)).toBeUndefined();
    expect(await workspace.readAllStates()).toEqual([]);
    // A cloud Host can delete nothing on the remote, so nothing here does.
    expect(git(remote, "branch", "--list", STATE_BRANCH)).toContain(STATE_BRANCH);
    expect(onRemote()).toEqual([]);
  });

  it("leaves the main checkout exactly as it was", async () => {
    const head = git(repo, "rev-parse", "HEAD");

    await workspace.writeState(state);
    await workspace.removeState(4);

    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "branch", "--list", STATE_BRANCH)).toBe("");
  });

  describe("and the transcripts of a handed-off Ticket's Stages", () => {
    /** Write what a Run's Stages leave for `ticket`, as the agent runner names it. */
    function stageLogs(runId: string, ticket: number, files: Record<string, string>): void {
      for (const [name, contents] of Object.entries(files)) {
        const path = join(stageLogDir(repo, runId, ticket), name);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, contents);
      }
    }

    /** Every file under `ticket-<n>/` on the remote's state branch, by path. */
    function keptOnRemote(ticket: number): string[] {
      return git(remote, "ls-tree", "-r", "--name-only", STATE_BRANCH, `ticket-${ticket}/`)
        .split("\n")
        .filter(Boolean);
    }

    beforeEach(() => {
      writeRunVersion(repo, "run-1", "0.4.0");
      stageLogs("run-1", 4, {
        "implement.command": "claude -p implement\n",
        "implement.stdout": "raw stream\n",
        "implement.stderr": "",
        "implement.transcript.jsonl": '{"type":"result"}\n',
        "verify.command": "claude -p verify\n",
        "verify.transcript.jsonl": "{}\n",
        "retry/fix.command": "claude -p fix\n",
        "retry/fix.transcript.jsonl": "{}\n",
      });
    });

    it("keeps each Stage's command line and transcript under the Ticket, retries included", async () => {
      await workspace.writeState(state);

      const kept = await workspace.keepTranscripts(4, "run-1");

      expect(kept).toEqual({ branch: STATE_BRANCH, path: "ticket-4/run-1/" });
      // The Version beside them, as it is beside them on the Host that ran them.
      expect(keptOnRemote(4)).toEqual([
        "ticket-4/run-1/implement.command",
        "ticket-4/run-1/implement.transcript.jsonl",
        "ticket-4/run-1/retry/fix.command",
        "ticket-4/run-1/retry/fix.transcript.jsonl",
        "ticket-4/run-1/verify.command",
        "ticket-4/run-1/verify.transcript.jsonl",
        "ticket-4/run-1/version.txt",
      ]);
      expect(git(remote, "show", `${STATE_BRANCH}:ticket-4/run-1/implement.command`)).toBe(
        "claude -p implement",
      );
      expect(git(remote, "show", `${STATE_BRANCH}:ticket-4/run-1/version.txt`)).toBe("0.4.0");
      expect(await workspace.readState(4)).toEqual(state);
      expect(git(remote, "rev-list", "--count", STATE_BRANCH)).toBe("1");
    });

    it("keeps an earlier Run's beside a later one's, and another Ticket's apart", async () => {
      stageLogs("run-2", 4, { "fix.command": "claude -p fix\n" });
      stageLogs("run-2", 9, { "implement.command": "claude -p implement\n" });

      await workspace.keepTranscripts(4, "run-1");
      await workspace.keepTranscripts(4, "run-2");
      await workspace.keepTranscripts(9, "run-2");

      expect(keptOnRemote(4)).toContain("ticket-4/run-1/implement.command");
      expect(keptOnRemote(4)).toContain("ticket-4/run-2/fix.command");
      expect(keptOnRemote(9)).toEqual(["ticket-9/run-2/implement.command"]);
    });

    it("keeps nothing, and creates nothing, for a Run that left no Stage of the Ticket's", async () => {
      expect(await workspace.keepTranscripts(5, "run-1")).toBeUndefined();

      expect(git(remote, "branch", "--list", STATE_BRANCH)).toBe("");
    });

    it("go when the Ticket's State does, and no other Ticket's go with them", async () => {
      stageLogs("run-1", 9, { "implement.command": "claude -p implement\n" });
      await workspace.writeState(state);
      await workspace.writeState({ ...state, ticket: 9, branch: "agent/9-x" });
      await workspace.keepTranscripts(4, "run-1");
      await workspace.keepTranscripts(9, "run-1");

      await workspace.removeState(4);

      expect(onRemote()).toEqual(["ticket-9.json", "ticket-9"]);
    });

    it("go on their own where the State was already gone", async () => {
      await workspace.keepTranscripts(4, "run-1");

      await workspace.removeState(4);

      expect(onRemote()).toEqual([]);
    });

    it("are read by nothing that reads the State", async () => {
      await workspace.writeState(state);
      await workspace.keepTranscripts(4, "run-1");

      expect(await workspace.readAllStates()).toEqual([{ readable: true, state }]);
    });
  });
});

describe("hasRemoteBranch", () => {
  it("says yes about a branch the remote has, pushed from here or not", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");
    await workspace.push(path, "agent/2-x");

    expect(await workspace.hasRemoteBranch("agent/2-x")).toBe(true);
    expect(await workspace.hasRemoteBranch("main")).toBe(true);
  });

  it("says no about a branch only this Host has", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" }, "main");

    expect(await workspace.hasRemoteBranch("agent/2-x")).toBe(false);
  });
});

describe("the Run lock", () => {
  const HERE: Host = { kind: "workstation", id: "4f1c0ffee", name: "desk" };
  const CLOUD: Host = { kind: "cloud", id: "session_01abc", name: "runsc" };
  const claim = {
    pid: 111,
    command: "agent-pipeline run",
    runId: "run-1",
    startedAt: "2026-09-17T09:00:00.000Z",
  };

  /** A checkout of the remote on `host`, whose process table holds `alive` pids. */
  function on(host: Host, alive: Record<number, string>, cwd = repo): GitWorkspace {
    return new GitWorkspace(cwd, "origin", {
      host,
      checkProcess: (pid) =>
        pid in alive ? { alive: true, startedAt: alive[pid] } : { alive: false },
    });
  }

  /** A second checkout of the same remote, standing for another Host's. */
  function clone(): string {
    const other = mkdtempSync(join(tmpdir(), "agent-pipeline-host-"));
    created.push(other);
    git(other, "clone", remote, ".");
    git(other, "config", "user.email", "pipeline@example.com");
    git(other, "config", "user.name", "agent-pipeline");
    return other;
  }

  /** The lock branch's commit subjects on the remote, newest first. */
  function history(): string[] {
    return git(remote, "log", "--format=%s", LOCK_BRANCH).split("\n");
  }

  /** Who the lock file at the remote's tip names. */
  function tipHolder(): LockHolder | undefined {
    return readLockFile(git(remote, "show", `${LOCK_BRANCH}:${LOCK_FILE}`));
  }

  /** What a human, or a Run elsewhere, commits to the lock branch from `cwd`. */
  function commitLock(cwd: string, holder: LockHolder | undefined): void {
    git(cwd, "fetch", "origin", LOCK_BRANCH);
    git(cwd, "checkout", "-B", "lock", "FETCH_HEAD");
    writeFileSync(join(cwd, LOCK_FILE), lockFileContents(holder));
    git(cwd, "commit", "-am", holder === undefined ? "Release it by hand" : "Take it elsewhere");
    git(cwd, "push", "origin", `lock:${LOCK_BRANCH}`);
  }

  it("creates the branch free where the remote has none, and takes it on top", async () => {
    const workspace = on(HERE, { 111: "A" });

    expect(await workspace.takeRunLock(claim)).toEqual({ outcome: "taken" });

    expect(history()).toEqual([
      "Held by run run-1 on the workstation `desk`: agent-pipeline run",
      "Free",
    ]);
    expect(tipHolder()).toEqual({ host: HERE, ...claim, processStartedAt: "A" });
    expect(await workspace.runLockHolder()).toEqual({
      holder: { host: HERE, ...claim, processStartedAt: "A" },
      onAnotherHost: false,
    });
  });

  it("refuses a second Run on this Host while the holder is running, naming it", async () => {
    await on(HERE, { 111: "A" }).takeRunLock(claim);

    const second = on(HERE, { 111: "A", 222: "B" });

    expect(await second.takeRunLock({ ...claim, pid: 222, runId: "run-2" })).toEqual({
      outcome: "held",
      holder: { host: HERE, ...claim, processStartedAt: "A" },
      onAnotherHost: false,
    });
    expect(tipHolder()?.runId).toBe("run-1");
  });

  it("refuses a Run whose push lands on a tip another Run moved since it read it", async () => {
    const first = on(HERE, { 111: "A" });
    await first.takeRunLock(claim);
    await first.releaseRunLock();
    const freeTip = git(remote, "rev-parse", LOCK_BRANCH);
    const elsewhere = { host: CLOUD, ...claim, runId: "cloud-run" };

    // Asked for its own start time between reading the free tip and pushing
    // on it, which is where a Run on the cloud Host takes the same tip first.
    const other = clone();
    let raced = false;
    const racing = new GitWorkspace(repo, "origin", {
      host: HERE,
      checkProcess: (pid) => {
        if (pid === 222 && !raced) {
          raced = true;
          commitLock(other, elsewhere);
        }
        return { alive: true, startedAt: "B" };
      },
    });

    const outcome = await racing.takeRunLock({ ...claim, pid: 222, runId: "run-2" });

    expect(raced).toBe(true);
    expect(git(remote, "rev-parse", `${LOCK_BRANCH}^`)).toBe(freeTip);
    expect(outcome).toEqual({ outcome: "held", holder: elsewhere, onAnotherHost: true });
    expect(tipHolder()).toEqual(elsewhere);
  });

  it("lets only one of two Runs starting at once on two Hosts take it", async () => {
    const outcomes = await Promise.all([
      on(HERE, { 111: "A" }).takeRunLock(claim),
      on(CLOUD, { 111: "A" }, clone()).takeRunLock({ ...claim, runId: "cloud-run" }),
    ]);

    expect(outcomes.filter((outcome) => outcome.outcome === "taken")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.outcome === "held")).toHaveLength(1);
  });

  it("finds a holder on this Host whose process has gone abandoned, and takes it over", async () => {
    await on(HERE, { 111: "A" }).takeRunLock(claim);
    const deadTip = git(remote, "rev-parse", LOCK_BRANCH);
    const next = on(HERE, { 222: "B" });

    expect(await next.runLockHolder()).toBeUndefined();
    expect(await next.takeRunLock({ ...claim, pid: 222, runId: "run-2" })).toEqual({
      outcome: "abandoned",
    });
    expect(await next.takeOverRunLock({ ...claim, pid: 222, runId: "run-2" })).toEqual({
      outcome: "taken",
    });

    expect(tipHolder()?.runId).toBe("run-2");
    // Taken over on top of the dead holder's commit, which is still there.
    expect(git(remote, "rev-parse", `${LOCK_BRANCH}^`)).toBe(deadTip);
  });

  it("never takes over a holder on another Host, whatever this Host's processes say", async () => {
    await on(CLOUD, { 111: "A" }, clone()).takeRunLock(claim);
    const here = on(HERE, {});

    const held = { holder: { host: CLOUD, ...claim, processStartedAt: "A" }, onAnotherHost: true };
    expect(await here.takeRunLock({ ...claim, pid: 222 })).toEqual({ outcome: "held", ...held });
    expect(await here.takeOverRunLock({ ...claim, pid: 222 })).toEqual({ outcome: "held", ...held });
    expect(await here.runLockHolder()).toEqual(held);
    expect(tipHolder()?.host).toEqual(CLOUD);
  });

  it("is released by a free commit on top, and nothing is deleted", async () => {
    const running = on(HERE, { 111: "A" });
    await running.takeRunLock(claim);

    await running.releaseRunLock();

    expect(history()).toEqual([
      "Free",
      "Held by run run-1 on the workstation `desk`: agent-pipeline run",
      "Free",
    ]);
    expect(tipHolder()).toBeUndefined();
    expect(await running.runLockHolder()).toBeUndefined();
    expect(await on(HERE, { 222: "B" }).takeRunLock({ ...claim, pid: 222 })).toEqual({
      outcome: "taken",
    });
  });

  it("is taken again once a human commits a free tip to it on GitHub", async () => {
    await on(CLOUD, { 111: "A" }, clone()).takeRunLock(claim);

    commitLock(clone(), undefined);

    expect(await on(HERE, {}).takeRunLock({ ...claim, pid: 222 })).toEqual({ outcome: "taken" });
    expect(tipHolder()?.host).toEqual(HERE);
  });

  it("releases nothing another Run holds by now", async () => {
    const released = on(HERE, { 111: "A" });
    await released.takeRunLock(claim);
    // A human released the lock on GitHub, and a cloud Run took it.
    const other = clone();
    commitLock(other, undefined);
    const elsewhere = { host: CLOUD, ...claim, runId: "cloud-run" };
    commitLock(other, elsewhere);

    await released.releaseRunLock();

    expect(tipHolder()).toEqual(elsewhere);
  });

  it("releases nothing when this Workspace took nothing", async () => {
    await on(HERE, { 111: "A" }).takeRunLock(claim);

    await on(HERE, { 111: "A" }).releaseRunLock();

    expect(tipHolder()?.runId).toBe("run-1");
  });

  it("reads nobody, and creates nothing, where the remote has no lock branch", async () => {
    expect(await on(HERE, {}).runLockHolder()).toBeUndefined();
    expect(git(remote, "branch", "--list", LOCK_BRANCH)).toBe("");
  });
});
