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
  it("reports a passing command with its output", async () => {
    const result = await workspace.runCheck("echo hello", repo);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("reports a failing command and captures stderr", async () => {
    const result = await workspace.runCheck("echo boom >&2; exit 3", repo);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("boom");
  });

  it("runs the command in the directory it is given", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });

    const result = await workspace.runCheck("pwd", path);

    expect(result.output).toContain("ticket-2");
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

  it("reports a conflict and leaves no rebase in progress", async () => {
    const path = join(repo, ".worktrees", "ticket-2");
    await workspace.createWorktree({ path, branch: "agent/2-x" });
    commit(path, "README.md", "branch version\n", "feat: branch edit (#2)");
    commit(repo, "README.md", "main version\n", "feat: main edit (#1)");

    const result = await workspace.rebaseOnMain(path);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a conflict");
    expect(result.conflict).toContain("README.md");
    expect(existsSync(join(path, ".git", "rebase-merge"))).toBe(false);
    expect(git(path, "status", "--porcelain")).toBe("");
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
