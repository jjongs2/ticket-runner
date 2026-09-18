import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { CLAUDE_SECTION, CONVENTIONS_DOC, CONVENTIONS_PATH } from "./conventions.js";
import { initTarget } from "./init.js";
import { STAGE_ENV_VAR } from "./stage-guard.js";
import { FakeAgentRunner, FakeTracker } from "./testing/fakes.js";

let repoRoot: string;
let tracker: FakeTracker;
let runner: FakeAgentRunner;

/** The six triage labels, in the order {@link initTarget} creates them. */
const ALL_LABELS = [
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
  "in-progress",
];

/** A Target that has everything only the human can put there. */
function readyToReport(root: string): void {
  write(root, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
  write(root, join(".github", "workflows", "ci.yml"), "on: push\n");
}

function write(root: string, path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/** Every file under `root`, by path, as a Target's whole visible state. */
function snapshot(root: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, snapshot(join(root, entry.name), path));
    else files[path] = readFileSync(join(root, entry.name), "utf8");
  }
  return files;
}

/** One `init`, in a human's shell unless the test says otherwise. */
async function init(overrides: { root?: string; env?: NodeJS.ProcessEnv } = {}) {
  const root = overrides.root ?? repoRoot;
  const out: string[] = [];
  const err: string[] = [];
  const code = await initTarget({
    repoRoot: root,
    config: loadConfig(root),
    tracker,
    runner,
    env: overrides.env ?? {},
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "agent-pipeline-init-"));
  tracker = new FakeTracker();
  runner = new FakeAgentRunner();
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("what init writes into the Target", () => {
  it("leaves an empty Target with everything a Run expects to find", async () => {
    await init();

    const gitignore = read(repoRoot, ".gitignore");
    expect(gitignore).toContain(".worktrees/");
    expect(gitignore).toContain(".agent-pipeline/");
    expect(read(repoRoot, "agent-pipeline.json")).toBe("{}\n");
    expect(read(repoRoot, CONVENTIONS_PATH)).toBe(CONVENTIONS_DOC);
    expect(read(repoRoot, "CLAUDE.md")).toContain(CONVENTIONS_PATH);
  });

  it("says what it wrote, one line per file", async () => {
    const { out } = await init();

    expect(out).toMatch(/\.gitignore: added/);
    expect(out).toMatch(/agent-pipeline\.json: created/);
    expect(out).toMatch(new RegExp(`${CONVENTIONS_PATH}: written`));
    expect(out).toMatch(/CLAUDE\.md: created/);
  });

  it("creates the six triage labels and turns squash merging on", async () => {
    await init();

    expect(tracker.createdLabels.map((label) => label.name)).toEqual(ALL_LABELS);
    // Each carries the colour and the meaning a human reads off the board.
    expect(tracker.createdLabels.every((label) => /^[0-9a-f]{6}$/.test(label.color))).toBe(true);
    expect(tracker.createdLabels.every((label) => label.description !== "")).toBe(true);
    expect(tracker.squashMergeEnabled).toBe(true);
  });

  it("writes nothing and creates nothing the second time", async () => {
    await init();
    const after = snapshot(repoRoot);
    tracker.createdLabels = [];
    tracker.calls = [];

    const { out } = await init();

    expect(out).toContain("nothing to write");
    expect(snapshot(repoRoot)).toEqual(after);
    expect(tracker.createdLabels).toEqual([]);
    // Squash merging is asked for every time and creates nothing: GitHub
    // reports no difference between turning it on and finding it on.
    expect(tracker.calls).toEqual(["enableSquashMerge"]);
  });

  it("adds only the missing lines to a gitignore that already has its own", async () => {
    write(repoRoot, ".gitignore", "node_modules/\ndist/\n");

    const { out } = await init();

    const gitignore = read(repoRoot, ".gitignore");
    expect(gitignore.startsWith("node_modules/\ndist/\n")).toBe(true);
    expect(gitignore).toContain(".worktrees/");
    expect(gitignore).toContain(".agent-pipeline/");
    expect(out).toMatch(/\.gitignore: added `\.worktrees\/` and `\.agent-pipeline\/`/);
  });

  it("adds only the one directory a gitignore is missing", async () => {
    write(repoRoot, ".gitignore", "# ours\n.worktrees/\n");

    const { out } = await init();

    expect(out).toMatch(/\.gitignore: added `\.agent-pipeline\/`$/m);
    expect(read(repoRoot, ".gitignore")).toBe(
      "# ours\n.worktrees/\n\n# Run logs, transcripts and state.\n.agent-pipeline/\n",
    );
  });

  it("adds nothing for a directory the Target ignores under another spelling", async () => {
    write(repoRoot, ".gitignore", "/.worktrees/\n.agent-pipeline\n");

    const { out } = await init();

    expect(read(repoRoot, ".gitignore")).toBe("/.worktrees/\n.agent-pipeline\n");
    expect(out).not.toMatch(/\.gitignore:/);
  });

  it("appends to a CLAUDE.md that says other things, keeping every line of it", async () => {
    const existing = "# Acme\n\n## House rules\n\nReview your own diff.\n";
    write(repoRoot, "CLAUDE.md", existing);

    await init();

    const claude = read(repoRoot, "CLAUDE.md");
    expect(claude.startsWith(existing)).toBe(true);
    expect(claude).toContain(CLAUDE_SECTION);
  });

  it("leaves a CLAUDE.md that already points at the document alone", async () => {
    const existing = `# Acme\n\nConventions: see \`${CONVENTIONS_PATH}\` first.\n`;
    write(repoRoot, "CLAUDE.md", existing);

    const { out } = await init();

    expect(read(repoRoot, "CLAUDE.md")).toBe(existing);
    expect(out).not.toMatch(/CLAUDE\.md:/);
  });

  it("leaves a config file that exists untouched, whatever it says", async () => {
    const existing = '{\n  "baseBranch": "trunk"\n}\n';
    write(repoRoot, "agent-pipeline.json", existing);

    const { out } = await init();

    expect(read(repoRoot, "agent-pipeline.json")).toBe(existing);
    expect(out).not.toMatch(/agent-pipeline\.json:/);
  });

  it("overwrites a conventions document that says something else, and says it did", async () => {
    write(repoRoot, CONVENTIONS_PATH, "# Conventions\n\nFrom an older pipeline.\n");

    const { out } = await init();

    expect(read(repoRoot, CONVENTIONS_PATH)).toBe(CONVENTIONS_DOC);
    expect(out).toMatch(new RegExp(`${CONVENTIONS_PATH}: overwritten`));
  });

  it("points CLAUDE.md at the document it writes", () => {
    expect(CLAUDE_SECTION).toContain(CONVENTIONS_PATH);
  });
});

describe("what init does on GitHub", () => {
  it("creates only the labels the Target is missing", async () => {
    tracker.labels = new Set(["needs-triage", "wontfix"]);

    const { out } = await init();

    expect(tracker.createdLabels.map((label) => label.name)).toEqual([
      "needs-info",
      "ready-for-agent",
      "ready-for-human",
      "in-progress",
    ]);
    expect(out).toMatch(/labels: created needs-info, ready-for-agent/);
  });

  it("creates the labels the config names rather than the default ones", async () => {
    write(repoRoot, "agent-pipeline.json", '{"labels":{"readyForAgent":"afk-ready"}}');

    await init();

    expect(tracker.createdLabels.map((label) => label.name)).toContain("afk-ready");
    expect(tracker.createdLabels.map((label) => label.name)).not.toContain("ready-for-agent");
  });

  it("does nothing on GitHub when gh is not authenticated", async () => {
    tracker.isAuthenticated = false;

    const { out } = await init();

    expect(tracker.createdLabels).toEqual([]);
    expect(tracker.squashMergeEnabled).toBe(false);
    expect(out).toMatch(/GitHub:\n {2}nothing done: `gh` is not authenticated/);
  });
});

describe("what init only reports", () => {
  it("passes every item in a Target that has everything, and exits 0", async () => {
    readyToReport(repoRoot);

    const { code, out } = await init();

    expect(marks(out)).toEqual(["✓", "✓", "✓", "✓", "✓"]);
    expect(out).toMatch(/✓ `gh` is authenticated/);
    expect(out).toMatch(/✓ `claude` runs/);
    expect(out).toMatch(/✓ the `mattpocock-skills` plugin is installed/);
    expect(out).toMatch(/✓ a CI workflow is present/);
    expect(out).toMatch(/✓ a Check is configured or inferable: npm test/);
    expect(code).toBe(0);
  });

  it("fails the gh line and exits 1 when gh is not authenticated", async () => {
    readyToReport(repoRoot);
    tracker.isAuthenticated = false;

    const { code, out } = await init();

    expect(out).toMatch(/✗ `gh` is not authenticated — run `gh auth login`/);
    expect(code).toBe(1);
  });

  it("fails both agent lines and exits 1 when claude cannot be run", async () => {
    readyToReport(repoRoot);
    runner.preflightAnswer = { runs: false, plugin: false };

    const { code, out } = await init();

    expect(out).toMatch(/✗ `claude` could not be run/);
    expect(out).toMatch(/✗ the `mattpocock-skills` plugin is not installed/);
    expect(code).toBe(1);
  });

  it("fails the plugin line and exits 1 when only the plugin is missing", async () => {
    readyToReport(repoRoot);
    runner.preflightAnswer = { runs: true, plugin: false };

    const { code, out } = await init();

    expect(out).toMatch(/✓ `claude` runs/);
    expect(out).toMatch(/✗ the `mattpocock-skills` plugin is not installed/);
    expect(code).toBe(1);
  });

  it("fails the CI line and exits 1 when the Actions directory holds no workflow", async () => {
    readyToReport(repoRoot);
    rmSync(join(repoRoot, ".github", "workflows", "ci.yml"));

    const { code, out } = await init();

    expect(out).toMatch(/✗ no CI workflow in/);
    expect(code).toBe(1);
  });

  it("fails the Check line and exits 1 when nothing could gate a merge", async () => {
    readyToReport(repoRoot);
    write(repoRoot, "package.json", JSON.stringify({ name: "acme" }));

    const { code, out } = await init();

    expect(out).toMatch(/✗ no Check is configured or inferable/);
    expect(code).toBe(1);
  });

  it("asks the agent runner once, and never starts a Stage", async () => {
    await init();

    expect(runner.preflights).toBe(1);
    expect(runner.requests).toEqual([]);
  });
});

describe("the Stage boundary", () => {
  it("refuses a Stage's shell before it reads or writes anything", async () => {
    const { code, err } = await init({ env: { [STAGE_ENV_VAR]: "implement" } });

    expect(code).toBe(2);
    expect(err).toMatch(/Refusing to start/);
    expect(snapshot(repoRoot)).toEqual({});
    expect(tracker.calls).toEqual([]);
    expect(runner.preflights).toBe(0);
  });
});

describe("the reference Target", () => {
  /** This checkout: the repository whose own setup `init` has to reproduce. */
  const ownRoot = fileURLToPath(new URL("..", import.meta.url));

  /** What no Target of any kind carries into a copy of itself. */
  const NOT_THE_TARGET = new Set([".git", "node_modules", ".worktrees", ".agent-pipeline"]);

  it("changes no file of this repository", async () => {
    const copy = mkdtempSync(join(tmpdir(), "agent-pipeline-reference-"));
    try {
      cpSync(ownRoot, copy, {
        recursive: true,
        filter: (source) => !NOT_THE_TARGET.has(basename(source)),
      });
      const before = snapshot(copy);

      const { code } = await init({ root: copy });

      expect(snapshot(copy)).toEqual(before);
      expect(code).toBe(0);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});

/** The pass and fail marks of the report, in the order they were printed. */
function marks(out: string): string[] {
  return [...out.matchAll(/^ {2}([✓✗]) /gm)].map((match) => match[1] as string);
}
