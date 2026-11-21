import { describe, expect, it } from "vitest";
import { anyWorkflowCanRun, isWorkflowPath, workflowCanRun, type PullRequestPush } from "./workflows.js";

const PR: PullRequestPush = {
  base: "main",
  head: "agent/7-docs",
  changed: ["docs/guide.md", "README.md"],
};

const canRun = (contents: string, pr: Partial<PullRequestPush> = {}) =>
  workflowCanRun(contents, { ...PR, ...pr });

describe("workflowCanRun", () => {
  describe("rules a workflow out", () => {
    it("when it runs on schedule, by hand and on a pull request whose paths match no changed file", () => {
      const workflow = [
        "on:",
        "  schedule:",
        "    - cron: '0 3 * * *'",
        "  workflow_dispatch:",
        "  pull_request:",
        "    paths: ['src/**', 'package.json']",
      ].join("\n");
      expect(canRun(workflow)).toBe(false);
    });

    it("when every event is one that never runs on a pull request's push", () => {
      expect(canRun("on: [schedule, workflow_dispatch, repository_dispatch, workflow_call]")).toBe(false);
    });

    it("when its push branches filter excludes the pull request's branch", () => {
      expect(canRun("on:\n  push:\n    branches: [main, 'release/**']")).toBe(false);
    });

    it("when its push branches-ignore filter matches the pull request's branch", () => {
      expect(canRun("on:\n  push:\n    branches-ignore: ['agent/**']")).toBe(false);
    });

    it("when its pull_request branches filter excludes the base branch", () => {
      expect(canRun("on:\n  pull_request:\n    branches: [develop]")).toBe(false);
    });

    it("when its pull_request branches-ignore filter matches the base branch", () => {
      expect(canRun("on:\n  pull_request:\n    branches-ignore: [main]")).toBe(false);
    });

    it("when every changed file matches its paths-ignore filter", () => {
      expect(canRun("on:\n  pull_request:\n    paths-ignore: ['docs/**', '*.md']")).toBe(false);
    });

    it("by a filter it evaluates even beside one it does not", () => {
      const workflow = "on:\n  pull_request:\n    types: [opened, synchronize]\n    paths: ['src/**']";
      expect(canRun(workflow)).toBe(false);
      expect(canRun("on:\n  push:\n    branches: [main]\n    tags: ['v*']\n    paths: ['docs/**']")).toBe(false);
    });

    it("counting a renamed file under both its paths", () => {
      const workflow = "on:\n  pull_request:\n    paths: ['src/**']";
      expect(canRun(workflow, { changed: ["lib/a.ts", "docs/a.md"] })).toBe(false);
      expect(canRun(workflow, { changed: ["src/a.ts", "lib/a.ts"] })).toBe(true);
    });

    it("by a `*` that does not cross a directory", () => {
      expect(canRun("on:\n  pull_request:\n    paths: ['src/*']", { changed: ["src/a/b.ts"] })).toBe(false);
    });
  });

  describe("lets a workflow run", () => {
    it("on a pull_request with no filter, in each shape `on` takes", () => {
      expect(canRun("on: pull_request")).toBe(true);
      expect(canRun("on: [schedule, pull_request]")).toBe(true);
      expect(canRun("on:\n  pull_request:")).toBe(true);
      expect(canRun("on:\n  pull_request: {}")).toBe(true);
    });

    it("on a paths filter that matches a changed file", () => {
      expect(canRun("on:\n  pull_request:\n    paths: ['docs/**']")).toBe(true);
    });

    it("on a push with no branch filter", () => {
      expect(canRun("on: push")).toBe(true);
      expect(canRun("on:\n  push:\n    paths: ['src/**']")).toBe(true);
      expect(canRun("on:\n  push:\n    tags: ['v*']")).toBe(true);
    });

    it("on `**.js` and a changed `src/js/app.js`, as GitHub reads it and a shell glob would not", () => {
      const workflow = "on:\n  pull_request:\n    paths: ['**.js']";
      expect(canRun(workflow, { changed: ["src/js/app.js"] })).toBe(true);
    });

    it("on `**/` matching no directory, as the cheat sheet's `docs/**/*.md` matches `docs/README.md`", () => {
      expect(canRun("on:\n  pull_request:\n    paths: ['docs/**/*.md']", { changed: ["docs/README.md"] })).toBe(true);
      expect(canRun("on:\n  pull_request:\n    paths: ['**/README.md']", { changed: ["README.md"] })).toBe(true);
    });

    it.each([
      ["?", "docs/?.md"],
      ["+", "docs+"],
      ["[]", "src/[ab].ts"],
      ["a leading !", "!docs/**"],
      ["braces", "src/{a,b}/**"],
      ["an escape", "src/\\*.ts"],
    ])("on a pattern with %s, which it does not read", (_, pattern) => {
      expect(canRun(`on:\n  pull_request:\n    paths: ['${pattern}']`)).toBe(true);
    });

    it("on a wildcard that would have to match a name starting with `.`", () => {
      const changed = [".github/dependabot.yml"];
      expect(canRun("on:\n  pull_request:\n    paths: ['**.yml']", { changed })).toBe(true);
      expect(canRun("on:\n  pull_request:\n    paths-ignore: ['**']", { changed })).toBe(true);
      expect(canRun("on:\n  pull_request:\n    paths-ignore: ['*/*']", { changed })).toBe(true);
      // A literal dot is no wildcard's to match.
      expect(canRun("on:\n  pull_request:\n    paths-ignore: ['.github/**']", { changed })).toBe(false);
    });

    it("on an event it does not know, or one that is not a pull request's push", () => {
      expect(canRun("on: [schedule, pull_request_target]")).toBe(true);
      expect(canRun("on:\n  merge_group:\n  workflow_dispatch:")).toBe(true);
      expect(canRun("on: issues")).toBe(true);
    });

    it("on a filter it does not evaluate when no evaluated filter rules the event out", () => {
      expect(canRun("on:\n  pull_request:\n    types: [labeled]")).toBe(true);
    });

    it.each([
      ["does not parse", "on: [push"],
      ["holds two documents", "on: push\n---\non: push"],
      ["repeats a key", "on: schedule\non: schedule"],
      ["has no `on`", "jobs: {}"],
      ["is not a map", "- on: schedule"],
      ["has an `on` of no event", "on: []"],
      ["names an event that is not a string", "on: [1]"],
      ["filters on something that is not a map", "on:\n  pull_request: main"],
    ])("on a file that %s", (_, contents) => {
      expect(canRun(contents)).toBe(true);
    });

    it("on a filter with nothing to match", () => {
      expect(canRun("on:\n  pull_request:\n    paths: ['src/**']", { changed: [] })).toBe(true);
      expect(canRun("on:\n  pull_request:\n    branches: []")).toBe(true);
      expect(canRun("on:\n  pull_request:\n    branches: [1]")).toBe(true);
    });
  });
});

describe("anyWorkflowCanRun", () => {
  it("says none can run on a Target with no workflow file", () => {
    expect(anyWorkflowCanRun([], PR)).toBe(false);
  });

  it("says one can run when any one of them can", () => {
    const files = [
      { path: ".github/workflows/nightly.yml", contents: "on: schedule" },
      { path: ".github/workflows/ci.yml", contents: "on: pull_request" },
    ];
    expect(anyWorkflowCanRun(files, PR)).toBe(true);
    expect(anyWorkflowCanRun(files.slice(0, 1), PR)).toBe(false);
  });
});

describe("isWorkflowPath", () => {
  it("takes YAML files in the workflows directory and nothing below or beside it", () => {
    expect(isWorkflowPath(".github/workflows/ci.yml")).toBe(true);
    expect(isWorkflowPath(".github/workflows/ci.yaml")).toBe(true);
    expect(isWorkflowPath(".github/workflows/nested/ci.yml")).toBe(false);
    expect(isWorkflowPath(".github/workflows/README.md")).toBe(false);
    expect(isWorkflowPath(".github/dependabot.yml")).toBe(false);
  });
});
