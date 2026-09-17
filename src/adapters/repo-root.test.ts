import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRepoRoot } from "./repo-root.js";

let repo: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "agent-pipeline-root-")));
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.email", "pipeline@example.com");
  git(repo, "config", "user.name", "pipeline");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "first");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("findRepoRoot", () => {
  it("is the checkout itself when that is where the command was started", async () => {
    expect(await findRepoRoot(repo)).toBe(repo);
  });

  it("is still the main checkout from inside a linked worktree", async () => {
    // Otherwise a `ticket` started in .worktrees/ticket-n would take its own
    // Run lock and never see the Run that is already draining the Frontier.
    const worktree = join(repo, ".worktrees", "ticket-5");
    git(repo, "worktree", "add", "-b", "agent/5-slug", worktree, "main");

    expect(await findRepoRoot(worktree)).toBe(repo);
  });

  it("is the same directory a nested subdirectory resolves to", async () => {
    const nested = join(repo, "src", "adapters");
    execFileSync("mkdir", ["-p", nested]);

    expect(await findRepoRoot(nested)).toBe(repo);
  });
});
