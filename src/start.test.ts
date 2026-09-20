import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_FILENAME, loadConfig } from "./config.js";
import { CLAUDE_SECTION, CONVENTIONS_DOC, CONVENTIONS_PATH } from "./conventions.js";
import { type Work, startRun } from "./start.js";
import type { StopSource } from "./stop.js";
import { FakeAgentRunner, FakeTracker, FakeWorkspace, stageResult } from "./testing/fakes.js";
import { settle } from "./testing/settle.js";

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
async function start(work: Work = { command: "run" }, signals?: StopSource) {
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
    ...(signals === undefined ? {} : { signals }),
  });
  return { code, out: out.join("\n"), lines: out, err: err.join("\n") };
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

  it("refuses `ticket <n>` over a missing label too, and claims nothing", async () => {
    tracker.addIssue({ number: 4 });
    tracker.labels.delete("in-progress");

    const { code, err } = await start({ command: "ticket", ticket: 4 });

    expect(code).toBe(2);
    expect(err).toContain("in-progress");
    expect(tracker.createdLabels).toEqual([]);
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

  it("takes the one Ticket `ticket <n>` names however many Lanes are configured", async () => {
    write(CONFIG_FILENAME, JSON.stringify({ lanes: 3 }));
    for (const number of [4, 5, 6]) tracker.addIssue({ number });

    const { code, out } = await start({ command: "ticket", ticket: 4 });

    expect(code).toBe(0);
    expect(out).toContain("merged   #4");
    // No Frontier to drain, so the other two are nobody's business here.
    expect(tracker.calls).not.toContain("listCandidates:ready-for-agent");
    expect(tracker.calls).not.toContain("assign:5:pipeline-user");
  });

  it("exits 1 when a Lane handed its Ticket off and 0 when none did", async () => {
    write(CONFIG_FILENAME, JSON.stringify({ lanes: 2 }));
    for (const number of [4, 5]) tracker.addIssue({ number });
    // #4 is handed off; #5 merges, in a Lane of its own.
    runner.queue("implement", { ok: false, failure: "nonzero-exit" });

    const { code, out } = await start();

    expect(code).toBe(1);
    expect(out).toContain("handed   #4");
    expect(out).toContain("merged   #5");
  });

  it("releases the Run lock it took", async () => {
    tracker.addIssue({ number: 4 });

    await start();

    expect(existsSync(join(repoRoot, ".agent-pipeline", "lock.json"))).toBe(false);
  });
});

describe("the Run log", () => {
  it("opens by naming the Lane count", async () => {
    tracker.addIssue({ number: 4 });

    const { lines } = await start();

    expect(lines[0]).toBe("agent-pipeline run run-1 · 1 lane");
  });

  it("names a configured Lane count in the plural", async () => {
    write(CONFIG_FILENAME, JSON.stringify({ lanes: 3 }));
    tracker.addIssue({ number: 4 });

    const { lines } = await start();

    expect(lines[0]).toBe("agent-pipeline run run-1 · 3 lanes");
  });

  it("names the Ticket rather than a Lane count for `ticket <n>`", async () => {
    write(CONFIG_FILENAME, JSON.stringify({ lanes: 3 }));
    tracker.addIssue({ number: 4 });

    const { lines } = await start({ command: "ticket", ticket: 4 });

    expect(lines[0]).toBe("agent-pipeline run run-1 · #4");
  });

  it("starts every line between the opening and the summary with a Ticket number", async () => {
    tracker.addIssue({ number: 4 });
    tracker.addIssue({ number: 7 });
    // A Spec offered as a Ticket, so a guard's line is in the log as well.
    tracker.addIssue({ number: 9, subIssues: 2 });

    const { lines } = await start();

    // Split on newlines as well: an entry a Stage logs in two lines is two
    // lines in the transcript, and the second one has to carry the number too.
    const ticketLines = lines.slice(1, -1).flatMap((entry) => entry.split("\n"));
    // Claimed, verified and merged for each of #4 and #7, and the guard's line
    // for #9. Counted rather than bounded, so a new Ticket line has to be
    // looked at here rather than slipping past an inequality.
    expect(ticketLines).toHaveLength(7);
    for (const line of ticketLines) expect(line).toMatch(/^#\d+ /);
  });
});

/**
 * SIGTERM, from the Run lock down: these drive the whole invocation, so what
 * they say is that a signal really does reach the Lanes — the pieces below
 * `startRun` are held to what a Stop is by their own tests.
 */
describe("a Run a human stopped", () => {
  it("finishes the Ticket in flight and claims no other", async () => {
    for (const number of [4, 5]) tracker.addIssue({ number });
    const signals = new EventEmitter();
    const implementing = runner.holds("implement");

    const run = start({ command: "run" }, signals);
    await implementing.started();
    await settle();
    signals.emit("SIGTERM");
    implementing.release();
    const { code, out, lines } = await run;

    expect(lines).toContain("#4 left to finish · stopped");
    expect(tracker.pullRequest(100).merged).toBe(true);
    expect(tracker.calls).not.toContain("assign:5:pipeline-user");
    expect(out.trimEnd().split("\n").at(-1)).toMatch(/^Stopped at \d\d:\d\d · finishing #4\.$/);
    // The Stop is not an outcome, so the exit code is the one #4 earned.
    expect(code).toBe(0);
  });

  it("still exits 1 when the Ticket it was finishing was handed off", async () => {
    tracker.addIssue({ number: 4 });
    workspace.failCheck("npm test", "1 test failed");
    const signals = new EventEmitter();
    const implementing = runner.holds("implement");

    const run = start({ command: "run" }, signals);
    await implementing.started();
    await settle();
    signals.emit("SIGTERM");
    implementing.release();
    const { code } = await run;

    expect(code).toBe(1);
  });

  it("lets `ticket <n>` finish its Ticket instead of dying", async () => {
    tracker.addIssue({ number: 4 });
    const signals = new EventEmitter();
    const implementing = runner.holds("implement");

    const run = start({ command: "ticket", ticket: 4 }, signals);
    await implementing.started();
    await settle();
    signals.emit("SIGTERM");
    implementing.release();
    const { code, out, lines } = await run;

    expect(code).toBe(0);
    expect(lines).toContain("#4 left to finish · stopped");
    expect(tracker.pullRequest(100).merged).toBe(true);
    // It drains no Frontier, so its summary claims nothing about one, and a
    // Stop that asked it for nothing it was not already doing is no exception.
    expect(out).not.toContain("Stopped at");
  });

  it("stops listening once the Run is over, so the process can exit", async () => {
    tracker.addIssue({ number: 4 });
    const signals = new EventEmitter();

    await start({ command: "run" }, signals);

    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
