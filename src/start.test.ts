import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { CLAUDE_SECTION, CONVENTIONS_DOC, CONVENTIONS_PATH } from "./conventions.js";
import { type Work, startRun } from "./start.js";
import { FakeAgentRunner, FakeTracker, FakeWorkspace, stageResult } from "./testing/fakes.js";

/** The six triage labels, under the names a Target keeps by default. */
const ALL_LABELS = [
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
  "in-progress",
];

const PASSING_VERDICT = {
  criteria: [{ text: "it works", status: "met", evidence: "npm test is green" }],
  pass: true,
};

let repoRoot: string;
let tracker: FakeTracker;
let runner: FakeAgentRunner;
let workspace: FakeWorkspace;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "agent-pipeline-start-"));
  // A Target as `init` leaves it: its own package.json, the two ignored
  // directories, the conventions document and a `CLAUDE.md` pointing at it.
  write("package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
  write(".gitignore", ".worktrees/\n.agent-pipeline/\n");
  write(CONVENTIONS_PATH, CONVENTIONS_DOC);
  write("CLAUDE.md", CLAUDE_SECTION);

  tracker = new FakeTracker();
  for (const name of ALL_LABELS) tracker.labels.add(name);
  runner = new FakeAgentRunner({ verify: stageResult({ result: PASSING_VERDICT }) });
  workspace = new FakeWorkspace();
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function write(path: string, contents: string): void {
  mkdirSync(dirname(join(repoRoot, path)), { recursive: true });
  writeFileSync(join(repoRoot, path), contents);
}

/** One invocation, as the CLI makes it once the arguments are understood. */
async function start(work: Work = { command: "run" }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await startRun({
    work,
    repoRoot,
    config: loadConfig(repoRoot),
    tracker,
    runner,
    workspace,
    runId: "run-1",
    command: "agent-pipeline run",
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/**
 * Whether the Run lock was ever taken. Taking it creates the directory it lives
 * in, which a Run that was refused before the lock never has.
 */
function lockTaken(): boolean {
  return existsSync(join(repoRoot, ".agent-pipeline"));
}

describe("a Target init has not set up", () => {
  it("refuses a gitignore missing one of the pipeline's directories", async () => {
    write(".gitignore", "node_modules/\n.agent-pipeline/\n");

    const { code, err } = await start();

    expect(code).toBe(2);
    expect(err).toContain(".worktrees/");
    expect(err).toContain("agent-pipeline init");
    expect(lockTaken()).toBe(false);
    // No Candidate read, and nothing written on GitHub either.
    expect(tracker.calls).toEqual([]);
  });

  it("refuses a Target missing a triage label, and creates none", async () => {
    tracker.labels.delete("ready-for-human");

    const { code, err } = await start();

    expect(code).toBe(2);
    expect(err).toContain("ready-for-human");
    expect(err).toContain("agent-pipeline init");
    expect(tracker.createdLabels).toEqual([]);
    expect(lockTaken()).toBe(false);
    expect(tracker.calls).toEqual([]);
  });

  it("refuses a Target with no conventions document", async () => {
    rmSync(join(repoRoot, CONVENTIONS_PATH));

    const { code, err } = await start();

    expect(code).toBe(2);
    expect(err).toContain(CONVENTIONS_PATH);
    expect(err).toContain("agent-pipeline init");
    expect(lockTaken()).toBe(false);
    expect(tracker.calls).toEqual([]);
  });

  it("refuses a `CLAUDE.md` that does not point at the conventions document", async () => {
    write("CLAUDE.md", "# acme\n\nNothing about the pipeline here.\n");

    const { code, err } = await start();

    expect(code).toBe(2);
    expect(err).toContain("CLAUDE.md");
    expect(err).toContain("agent-pipeline init");
    expect(lockTaken()).toBe(false);
    expect(tracker.calls).toEqual([]);
  });

  it("asks only whether the conventions document is there, never what it says", async () => {
    write(CONVENTIONS_PATH, "# Conventions\n\nAn older copy, saying something else.\n");
    tracker.addIssue({ number: 4 });

    const { code } = await start();

    expect(code).toBe(0);
    expect(tracker.calls).toContain("listCandidates:ready-for-agent");
  });

  it("takes a gitignore line however the Target punctuated it", async () => {
    write(".gitignore", "/.worktrees\n.agent-pipeline\n");
    tracker.addIssue({ number: 4 });

    const { code } = await start();

    expect(code).toBe(0);
  });

  it("refuses `ticket <n>` on the same Target as `run`", async () => {
    tracker.addIssue({ number: 4 });
    rmSync(join(repoRoot, CONVENTIONS_PATH));

    const { code, err } = await start({ command: "ticket", ticket: 4 });

    expect(code).toBe(2);
    expect(err).toContain(CONVENTIONS_PATH);
    expect(err).toContain("agent-pipeline init");
    expect(lockTaken()).toBe(false);
    expect(tracker.calls).toEqual([]);
  });
});

describe("a Target init has set up", () => {
  it("takes the Frontier and creates no label on the way", async () => {
    tracker.addIssue({ number: 4 });

    const { code, out } = await start();

    expect(code).toBe(0);
    expect(out).toContain("merged   #4");
    expect(tracker.createdLabels).toEqual([]);
    expect(tracker.calls).not.toContain("createLabel:in-progress");
  });

  it("takes one named Ticket and creates no label either", async () => {
    tracker.addIssue({ number: 4 });

    const { code } = await start({ command: "ticket", ticket: 4 });

    expect(code).toBe(0);
    expect(tracker.createdLabels).toEqual([]);
  });

  it("releases the Run lock it took", async () => {
    tracker.addIssue({ number: 4 });

    await start();

    expect(existsSync(join(repoRoot, ".agent-pipeline", "lock.json"))).toBe(false);
  });
});
