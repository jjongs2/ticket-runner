import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PACKAGE_ROOT, pipelineVersion } from "./version.js";

let root: string;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A package root with a number in it, which every install has. */
function packageJson(version = "0.4.0"): void {
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ version })}\n`);
}

/** Turn the package root into the one thing a global install never is. */
function checkout(): void {
  git("init", "--initial-branch=main");
  git("config", "user.email", "pipeline@example.com");
  git("config", "user.name", "Pipeline");
  git("add", "-A");
  git("commit", "-m", "chore: the commit a Version is read against");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-pipeline-version-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("an installed copy", () => {
  it("is the number in its package.json and nothing else", async () => {
    packageJson("0.4.0");

    expect(await pipelineVersion(root)).toBe("0.4.0");
  });

  it("says so when there is no number to read", async () => {
    expect(await pipelineVersion(root)).toBe("unknown");
  });
});

describe("a development checkout", () => {
  it("carries the commit it runs in semver's build-metadata position", async () => {
    packageJson();
    checkout();

    expect(await pipelineVersion(root)).toBe(`0.4.0+${git("rev-parse", "--short", "HEAD")}`);
  });

  it("marks a tree with uncommitted changes dirty", async () => {
    packageJson();
    checkout();
    writeFileSync(join(root, "src.ts"), "// not committed\n");

    expect(await pipelineVersion(root)).toBe(
      `0.4.0+${git("rev-parse", "--short", "HEAD")}.dirty`,
    );
  });

  it("counts a change to a tracked file as dirty too", async () => {
    packageJson();
    checkout();
    packageJson("0.5.0");

    expect(await pipelineVersion(root)).toBe(
      `0.5.0+${git("rev-parse", "--short", "HEAD")}.dirty`,
    );
  });

  it("is the number alone when the repository has no commit to name", async () => {
    packageJson();
    git("init", "--initial-branch=main");

    expect(await pipelineVersion(root)).toBe("0.4.0");
  });
});

describe("the package root", () => {
  it("is the directory this pipeline's own package.json sits in", async () => {
    // The one assertion that reads the real checkout: whatever the CLI computes
    // has to be the number this repository is actually on.
    expect(await pipelineVersion(PACKAGE_ROOT)).toMatch(/^\d+\.\d+\.\d+(\+[0-9a-f]+(\.dirty)?)?$/);
  });
});
