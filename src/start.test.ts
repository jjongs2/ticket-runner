import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_FILENAME, loadConfig } from "./config.js";
import { CLAUDE_SECTION, CONVENTIONS_PATH, conventionsDoc } from "./conventions.js";
import { OPERATOR_SKILL_PATH, operatorSkill } from "./operator-skill.js";
import { type Work, startRun } from "./start.js";
import type { StopSource } from "./stop.js";
import {
  ANOTHER_HOST,
  FakeAgentRunner,
  FakeTracker,
  FakeWorkspace,
  THIS_HOST,
  stageResult,
} from "./testing/fakes.js";
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

/** The Version this Run is, as the CLI resolves it once and hands it down. */
const VERSION = "0.4.0+331d79c";

const PASSING_VERDICT = {
  criteria: [{ text: "it works", status: "met", evidence: "npm test is green" }],
  pass: true,
};

let repoRoot: string;
let tracker: FakeTracker;
let runner: FakeAgentRunner;
let workspace: FakeWorkspace;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "ticket-runner-start-"));
  // A Target as `init` leaves it: its own package.json, the two ignored
  // directories, the conventions document, a `CLAUDE.md` pointing at it and
  // the Operator's skill.
  write("package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
  write(".gitignore", ".worktrees/\n.ticket-runner/\n");
  write(CONVENTIONS_PATH, conventionsDoc(VERSION));
  write("CLAUDE.md", CLAUDE_SECTION);
  write(OPERATOR_SKILL_PATH, operatorSkill());

  tracker = new FakeTracker();
  for (const name of ALL_LABELS) tracker.labels.add(name);
  tracker.deleteBranchOnMergeEnabled = true;
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

/** The pipeline's own repository, as the CLI reads it off the package. */
const REPOSITORY = "jjongs2/ticket-runner";

/** One invocation, as the CLI makes it once the arguments are understood. */
async function start(
  work: Work = { command: "run" },
  signals?: StopSource,
  repository?: string,
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await startRun({
    work,
    repoRoot,
    config: loadConfig(repoRoot, VERSION),
    tracker,
    runner,
    workspace,
    runId: "run-1",
    version: VERSION,
    ...(repository === undefined ? {} : { repository }),
    command: "ticket-runner run",
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    ...(signals === undefined ? {} : { signals }),
  });
  return { code, out: out.join("\n"), lines: out, err: err.join("\n") };
}

/** Whether the Run lock was ever asked for, which a Run refused before it never is. */
function lockTaken(): boolean {
  return workspace.calls.includes("takeRunLock");
}

describe("a Target init has not set up", () => {
  it("refuses a gitignore missing one of the pipeline's directories", async () => {
    write(".gitignore", "node_modules/\n.ticket-runner/\n");

    const { code, err } = await start();

    expect(code).toBe(2);
    expect(err).toContain(".worktrees/");
    expect(err).toContain("ticket-runner init");
    expect(lockTaken()).toBe(false);
    // No Candidate read, and nothing written on GitHub either.
    expect(tracker.calls).toEqual([]);
  });

  it("refuses a Target missing a triage label, and creates none", async () => {
    tracker.labels.delete("ready-for-human");

    const { code, err } = await start();

    expect(code).toBe(2);
    expect(err).toContain("ready-for-human");
    expect(err).toContain("ticket-runner init");
    expect(tracker.createdLabels).toEqual([]);
    expect(lockTaken()).toBe(false);
    expect(tracker.calls).toEqual([]);
  });

  it("refuses a Target with no conventions document", async () => {
    rmSync(join(repoRoot, CONVENTIONS_PATH));

    const { code, err } = await start();

    expect(code).toBe(2);
    expect(err).toContain(CONVENTIONS_PATH);
    expect(err).toContain("ticket-runner init");
    expect(lockTaken()).toBe(false);
    expect(tracker.calls).toEqual([]);
  });

  it("refuses a `CLAUDE.md` that does not point at the conventions document", async () => {
    write("CLAUDE.md", "# acme\n\nNothing about the pipeline here.\n");

    const { code, err } = await start();

    expect(code).toBe(2);
    expect(err).toContain("CLAUDE.md");
    expect(err).toContain("ticket-runner init");
    expect(lockTaken()).toBe(false);
    expect(tracker.calls).toEqual([]);
  });

  it("refuses a conventions document carrying no Version stamp", async () => {
    write(CONVENTIONS_PATH, "# ticket-runner conventions\n\nFrom an older pipeline.\n");

    const { code, err } = await start();

    expect(code).toBe(2);
    expect(err).toContain(CONVENTIONS_PATH);
    expect(err).toContain("no Version");
    expect(err).toContain("ticket-runner init");
    expect(lockTaken()).toBe(false);
    expect(tracker.calls).toEqual([]);
  });

  it("refuses a repository that keeps a pull request's branch after it merges", async () => {
    tracker.deleteBranchOnMergeEnabled = false;

    const { code, err } = await start();

    expect(code).toBe(2);
    expect(err).toContain("does not delete a pull request's branch");
    expect(err).toContain("ticket-runner init");
    expect(lockTaken()).toBe(false);
    expect(tracker.calls).toEqual([]);
  });

  it("refuses a Host without gh, saying so rather than crashing on the first GitHub call", async () => {
    tracker.authenticationAnswer = "not-installed";

    const { code, err } = await start();

    expect(code).toBe(2);
    expect(err).toBe(
      "This Target is not set up: `gh` is not installed — install the GitHub CLI from https://cli.github.com first. Run `ticket-runner init` here and start again; a Run puts nothing in place itself.",
    );
    expect(lockTaken()).toBe(false);
  });

  it("refuses a narrowed Run on a Host without gh too", async () => {
    tracker.addIssue({ number: 4 });
    tracker.authenticationAnswer = "not-installed";

    const { code, err } = await start({ command: "run", tickets: [4] });

    expect(code).toBe(2);
    expect(err).toContain("`gh` is not installed");
    expect(lockTaken()).toBe(false);
  });

  it("asks the Target's own files before whether gh is installed", async () => {
    rmSync(join(repoRoot, OPERATOR_SKILL_PATH));
    tracker.authenticationAnswer = "not-installed";

    const { err } = await start();

    expect(err).toContain(OPERATOR_SKILL_PATH);
    expect(err).not.toContain("`gh`");
  });

  it("refuses a Target without the Operator's skill", async () => {
    rmSync(join(repoRoot, OPERATOR_SKILL_PATH));

    const { code, err } = await start();

    expect(code).toBe(2);
    expect(err).toContain(OPERATOR_SKILL_PATH);
    expect(err).toContain("ticket-runner init");
    expect(lockTaken()).toBe(false);
    expect(tracker.calls).toEqual([]);
  });

  it("asks only whether the Operator's skill is there, never what it says", async () => {
    write(OPERATOR_SKILL_PATH, "---\nname: ticket-runner\n---\n\nAn older copy.\n");
    tracker.addIssue({ number: 4 });

    const { code } = await start();

    expect(code).toBe(0);
  });

  it("refuses a narrowed Run on a repository that keeps merged branches too", async () => {
    tracker.addIssue({ number: 4 });
    tracker.deleteBranchOnMergeEnabled = false;

    const { code, err } = await start({ command: "run", tickets: [4] });

    expect(code).toBe(2);
    expect(err).toContain("does not delete a pull request's branch");
    expect(lockTaken()).toBe(false);
    expect(tracker.calls).toEqual([]);
  });

  it("asks only whether the conventions document is there and stamped, never what it says", async () => {
    write(
      CONVENTIONS_PATH,
      `${conventionsDoc(VERSION).split("\n")[0]}\n\nA hand-edited copy, saying something else.\n`,
    );
    tracker.addIssue({ number: 4 });

    const { code } = await start();

    expect(code).toBe(0);
    expect(tracker.calls).toContain("listCandidates:ready-for-agent");
  });

  it("refuses the document's absence, and never what Version wrote it", async () => {
    write(CONVENTIONS_PATH, conventionsDoc("0.9.0"));
    tracker.addIssue({ number: 4 });

    const { code } = await start();

    expect(code).toBe(0);
    expect(tracker.calls).toContain("listCandidates:ready-for-agent");
  });

  it("takes a gitignore line however the Target punctuated it", async () => {
    write(".gitignore", "/.worktrees\n.ticket-runner\n");
    tracker.addIssue({ number: 4 });

    const { code } = await start();

    expect(code).toBe(0);
  });

  it("refuses a narrowed Run on the same Target as any Run", async () => {
    tracker.addIssue({ number: 4 });
    rmSync(join(repoRoot, CONVENTIONS_PATH));

    const { code, err } = await start({ command: "run", tickets: [4] });

    expect(code).toBe(2);
    expect(err).toContain(CONVENTIONS_PATH);
    expect(err).toContain("ticket-runner init");
    expect(lockTaken()).toBe(false);
    expect(tracker.calls).toEqual([]);
  });

  it("refuses a narrowed Run over a missing label too, and claims nothing", async () => {
    tracker.addIssue({ number: 4 });
    tracker.labels.delete("in-progress");

    const { code, err } = await start({ command: "run", tickets: [4] });

    expect(code).toBe(2);
    expect(err).toContain("in-progress");
    expect(tracker.createdLabels).toEqual([]);
    expect(lockTaken()).toBe(false);
    expect(tracker.calls).toEqual([]);
  });
});

/**
 * A Target an earlier pipeline left State files in, under the run directory:
 * resume state lives on the remote now, and nothing migrates them (ADR-0004).
 */
describe("a Target with State files left in its checkout", () => {
  it("refuses to start, naming the Tickets they belong to, and takes nothing", async () => {
    write(".ticket-runner/state/ticket-9.json", "{}");
    write(".ticket-runner/state/ticket-4.json", "{}");
    tracker.addIssue({ number: 6 });

    const { code, err } = await start();

    expect(code).toBe(2);
    expect(err).toContain("#4, #9");
    expect(err).toContain(join(".ticket-runner", "state"));
    expect(lockTaken()).toBe(false);
    expect(tracker.calls).toEqual([]);
  });

  it("refuses a narrowed Run too", async () => {
    write(".ticket-runner/state/ticket-4.json", "{}");
    tracker.addIssue({ number: 4 });

    const { code, err } = await start({ command: "run", tickets: [4] });

    expect(code).toBe(2);
    expect(err).toContain("#4");
    expect(lockTaken()).toBe(false);
  });

  it("starts as usual once the directory holds no Ticket's State", async () => {
    write(".ticket-runner/state/notes.txt", "a human's note");
    tracker.addIssue({ number: 6 });

    const { code } = await start();

    expect(code).toBe(0);
    expect(lockTaken()).toBe(true);
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

  it("takes a named Ticket and creates no label either", async () => {
    tracker.addIssue({ number: 4 });

    const { code } = await start({ command: "run", tickets: [4] });

    expect(code).toBe(0);
    expect(tracker.createdLabels).toEqual([]);
  });

  it("takes only the Tickets a narrowed Run names, however many Lanes it has", async () => {
    write(CONFIG_FILENAME, JSON.stringify({ lanes: 3 }));
    for (const number of [4, 5, 6]) tracker.addIssue({ number });

    const { code, out } = await start({ command: "run", tickets: [4, 6] });

    expect(code).toBe(0);
    expect(out).toContain("merged   #4");
    expect(out).toContain("merged   #6");
    expect(out).not.toContain("#5");
    expect(tracker.calls).not.toContain("assign:5:pipeline-user");
  });

  it("fills as many Lanes as the Run was started with, whatever the config says", async () => {
    for (const number of [4, 5, 6]) tracker.addIssue({ number });
    const implementing = runner.holds("implement");

    const run = start({ command: "run", lanes: 2 });
    await implementing.started();
    await settle();

    // The config names no Lanes, which is one; the Run was told two.
    expect(runner.stages()).toEqual(["implement", "implement"]);

    implementing.release();
    const { code, out } = await run;

    expect(code).toBe(0);
    for (const number of [4, 5, 6]) expect(out).toContain(`merged   #${number}`);
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

    expect(workspace.lock).toBeUndefined();
  });
});

/**
 * What the exit code reads off a Run: a hand-off first, then, for a narrowed
 * Run alone, whether it took any of the Tickets it was given.
 */
describe("the exit code", () => {
  it("is 1 for a narrowed Run that handed a Ticket off, whatever else it skipped", async () => {
    tracker.addIssue({ number: 4 });
    tracker.addIssue({ number: 5, labels: ["needs-triage"] });
    runner.queue("implement", { ok: false, failure: "nonzero-exit" });

    const { code } = await start({ command: "run", tickets: [4, 5] });

    expect(code).toBe(1);
  });

  it("is 2 for a narrowed Run that took none of its Tickets: skipped, blocked, or both", async () => {
    tracker.addIssue({ number: 4, labels: ["needs-triage"] });
    tracker.addIssue({ number: 5, body: "no criteria here" });
    tracker.addIssue({ number: 6 });
    tracker.openBlockers.set(6, 1);

    const { code, out } = await start({ command: "run", tickets: [4, 5, 6, 99] });

    expect(code).toBe(2);
    expect(out).toContain("skipped  #4 not-ready");
    expect(out).toContain("skipped  #5 no-criteria");
    expect(out).toContain("skipped  #6 blocked");
    expect(out).toContain("skipped  #99 no-issue");
    // Refused nothing: the Run started, took its lock and gave it back.
    expect(lockTaken()).toBe(true);
    expect(workspace.lock).toBeUndefined();
  });

  it("is 0 for a narrowed Run that merged one Ticket and skipped the rest", async () => {
    tracker.addIssue({ number: 4 });
    tracker.addIssue({ number: 5, assignees: ["octocat"] });

    const { code, out } = await start({ command: "run", tickets: [4, 5] });

    expect(code).toBe(0);
    expect(out).toContain("skipped  #5 claimed");
  });

  it("is 0 for a narrowed Run whose only Ticket was released, which counts as taken", async () => {
    tracker.addIssue({ number: 4 });
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    const { code, out } = await start({ command: "run", tickets: [4] });

    expect(code).toBe(0);
    expect(out).toContain("released #4");
  });

  it("is 0 for a Run that was not narrowed and skipped every candidate", async () => {
    tracker.addIssue({ number: 4, body: "no criteria here" });

    const { code, out } = await start();

    expect(code).toBe(0);
    expect(out).toContain("skipped  #4 no-criteria");
  });
});

describe("the Run lock", () => {
  const holder = {
    host: THIS_HOST,
    pid: 4321,
    command: "ticket-runner run",
    runId: "run-0",
    startedAt: "2026-09-17T09:00:00.000Z",
  };

  it("refuses a Run while another holds the lock, naming it, and takes nothing", async () => {
    workspace.lock = { holder, running: true };
    tracker.addIssue({ number: 4 });

    const { code, err } = await start();

    expect(code).toBe(2);
    expect(err).toContain("`ticket-runner run`");
    expect(err).toContain("pid 4321");
    expect(workspace.lock).toEqual({ holder, running: true });
    expect(tracker.calls).not.toContain("assign:4:pipeline-user");
  });

  it("takes over a lock whose Run on this Host has gone, and releases it at the end", async () => {
    workspace.lock = { holder, running: false };
    tracker.addIssue({ number: 4 });

    const { code, out } = await start();

    expect(code).toBe(0);
    expect(out).toContain("merged   #4");
    expect(workspace.calls).toContain("takeOverRunLock");
    expect(workspace.lock).toBeUndefined();
  });

  it("records this Host as the holder, with the Run and its command line", async () => {
    tracker.addIssue({ number: 4 });
    let recorded: unknown;
    runner.leaves("implement", () => {
      recorded = workspace.lock?.holder;
    });

    await start();

    expect(recorded).toMatchObject({
      host: THIS_HOST,
      pid: process.pid,
      runId: "run-1",
      command: "ticket-runner run",
    });
  });

  it("keeps the Run's exit code when the lock cannot be released, and says so", async () => {
    tracker.addIssue({ number: 4 });
    workspace.releaseRunLock = async () => {
      throw new Error("could not reach origin");
    };

    const { code, out, err } = await start();

    expect(code).toBe(0);
    expect(out).toContain("merged   #4");
    expect(err).toContain("could not reach origin");
    expect(err).toContain("`ticket-runner/lock`");
  });

  describe("held from another Host", () => {
    const foreign = { ...holder, host: ANOTHER_HOST };

    it("refuses the Run, naming the Host, the Run and when it started", async () => {
      workspace.lock = { holder: foreign, running: true };
      tracker.addIssue({ number: 4 });

      const { code, err } = await start();

      expect(code).toBe(2);
      expect(err).toContain("the cloud Host of session `session_01other`");
      expect(err).toContain("run-0");
      expect(err).toContain("2026-09-17T09:00:00.000Z");
      expect(tracker.calls).not.toContain("assign:4:pipeline-user");
    });

    it("says it is released through an Operator or a free tip on GitHub", async () => {
      workspace.lock = { holder: foreign, running: true };

      const { err } = await start();

      expect(err).toContain("Operator");
      expect(err).toContain("free tip to the `ticket-runner/lock` branch");
    });

    it("never takes it over, whatever this Host's process table says", async () => {
      // Nothing here can see a process on another Host, so a Run there that
      // is gone looks no different from one that is running.
      workspace.lock = { holder: foreign, running: false };
      tracker.addIssue({ number: 4 });

      const { code } = await start();

      expect(code).toBe(2);
      expect(workspace.lock).toEqual({ holder: foreign, running: false });
      expect(tracker.calls).not.toContain("assign:4:pipeline-user");
    });

    it("refuses a narrowed Run too, since it takes the same lock", async () => {
      workspace.lock = { holder: foreign, running: true };
      tracker.addIssue({ number: 4 });

      const { code, err } = await start({ command: "run", tickets: [4] });

      expect(code).toBe(2);
      expect(err).toContain("the cloud Host of session `session_01other`");
      expect(tracker.calls).not.toContain("assign:4:pipeline-user");
    });
  });
});

describe("the Version a Run ran", () => {
  /** What the file beside this Run's transcripts says, if it is there at all. */
  function recorded(): string | undefined {
    const path = join(repoRoot, ".ticket-runner", "runs", "run-1", "version.txt");
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  it("is named at the top of the Run's own transcript directory", async () => {
    tracker.addIssue({ number: 4 });

    await start();

    expect(recorded()).toBe(`${VERSION}\n`);
  });

  it("is there before the first Stage, so a killed Run still left it", async () => {
    tracker.addIssue({ number: 4 });
    let atFirstStage: string | undefined;
    const runStage = runner.run.bind(runner);
    runner.run = async (request) => {
      atFirstStage ??= recorded();
      return runStage(request);
    };

    await start();

    expect(atFirstStage).toBe(`${VERSION}\n`);
  });

  it("heads the summary the Run ends with", async () => {
    const { lines } = await start();

    expect(lines.at(-1)?.split("\n")[1]).toBe(`ticket-runner ${VERSION} run run-1 · 0m`);
  });

  it("is the same string the Progress comment on its Ticket carries", async () => {
    tracker.addIssue({ number: 4 });

    await start();

    const progress = tracker.updatedComments.at(-1)?.body ?? "";
    expect(progress.split("\n")[1]).toBe(
      `**ticket-runner** \`${VERSION}\` · run \`run-1\` · \`agent/4-ticket-4\``,
    );
  });
});

describe("the Run log", () => {
  it("opens by naming the Lane count", async () => {
    tracker.addIssue({ number: 4 });

    const { lines } = await start();

    expect(lines[0]).toBe("ticket-runner run run-1 · 1 lane");
  });

  it("names a configured Lane count in the plural", async () => {
    write(CONFIG_FILENAME, JSON.stringify({ lanes: 3 }));
    tracker.addIssue({ number: 4 });

    const { lines } = await start();

    expect(lines[0]).toBe("ticket-runner run run-1 · 3 lanes");
  });

  it("names the Lane count the Run was started with, whatever the config says", async () => {
    write(CONFIG_FILENAME, JSON.stringify({ lanes: 3 }));
    tracker.addIssue({ number: 4 });

    const { lines } = await start({ command: "run", lanes: 2 });

    expect(lines[0]).toBe("ticket-runner run run-1 · 2 lanes");
  });

  it("names the Tickets a narrowed Run was given after its Lane count", async () => {
    write(CONFIG_FILENAME, JSON.stringify({ lanes: 3 }));
    tracker.addIssue({ number: 4 });

    const { lines } = await start({ command: "run", tickets: [4, 12, 13] });

    expect(lines[0]).toBe("ticket-runner run run-1 · 3 lanes · #4 #12 #13");
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

  it("stops a narrowed Run as it stops any Run", async () => {
    for (const number of [4, 5]) tracker.addIssue({ number });
    const signals = new EventEmitter();
    const implementing = runner.holds("implement");

    const run = start({ command: "run", tickets: [4, 5] }, signals);
    await implementing.started();
    await settle();
    signals.emit("SIGTERM");
    implementing.release();
    const { code, out, lines } = await run;

    expect(code).toBe(0);
    expect(lines).toContain("#4 left to finish · stopped");
    expect(tracker.pullRequest(100).merged).toBe(true);
    expect(tracker.calls).not.toContain("assign:5:pipeline-user");
    expect(out.trimEnd().split("\n").at(-1)).toMatch(/^Stopped at \d\d:\d\d · finishing #4\.$/);
  });

  it("exits 2 when a narrowed Run is stopped before it took any of its Tickets", async () => {
    for (const number of [4, 5]) tracker.addIssue({ number });
    const signals = new EventEmitter();
    const listCandidates = tracker.listCandidates.bind(tracker);
    tracker.listCandidates = async (label) => {
      signals.emit("SIGTERM");
      return listCandidates(label);
    };

    const { code, out } = await start({ command: "run", tickets: [4, 5] }, signals);

    expect(tracker.calls).not.toContain("assign:4:pipeline-user");
    expect(out.trimEnd().split("\n").at(-1)).toMatch(/^Stopped at \d\d:\d\d · nothing to finish\.$/);
    expect(code).toBe(2);
  });

  it("stops listening once the Run is over, so the process can exit", async () => {
    tracker.addIssue({ number: 4 });
    const signals = new EventEmitter();

    await start({ command: "run" }, signals);

    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});

describe("what a Run says about another Version", () => {
  it("names both Versions at the top of the log and at the head of the summary", async () => {
    tracker.publishedVersionTag = "v0.5.0";
    tracker.addIssue({ number: 4 });

    const { lines, out } = await start({ command: "run" }, undefined, REPOSITORY);

    // Straight after the opening line, and again above the summary's header.
    expect(lines[0]).toContain("ticket-runner run run-1");
    expect(lines[1]).toContain("0.5.0");
    expect(lines[1]).toContain("0.4.0");
    const summary = (lines.at(-1) ?? "").trim().split("\n");
    expect(summary[0]).toBe(lines[1]);
    expect(summary[1]).toContain(`ticket-runner ${VERSION} run run-1`);
  });

  it("says it once to a narrowed Run as well", async () => {
    tracker.publishedVersionTag = "v0.5.0";
    tracker.addIssue({ number: 4 });

    const { lines } = await start({ command: "run", tickets: [4] }, undefined, REPOSITORY);

    expect(lines[1]).toContain("0.5.0");
  });

  it("says nothing where this Run is the latest Version", async () => {
    tracker.publishedVersionTag = "v0.4.0";
    tracker.addIssue({ number: 4 });

    const { out, code } = await start({ command: "run" }, undefined, REPOSITORY);

    expect(out).not.toContain("A newer Version");
    expect(code).toBe(0);
  });

  it("says nothing and takes the Frontier anyway where the lookup fails", async () => {
    tracker.versionTagFails = true;
    tracker.addIssue({ number: 4 });

    const { out, code } = await start({ command: "run" }, undefined, REPOSITORY);

    expect(out).not.toContain("A newer Version");
    expect(out).toContain("merged   #4");
    expect(code).toBe(0);
  });

  it("asks nothing at all where the package names no repository", async () => {
    tracker.publishedVersionTag = "v0.5.0";
    tracker.addIssue({ number: 4 });

    const { out } = await start();

    expect(tracker.versionTagLookups).toEqual([]);
    expect(out).not.toContain("A newer Version");
  });
});

describe("what a Run says about the Target's conventions document", () => {
  it("says nothing about a document its own Version wrote", async () => {
    tracker.addIssue({ number: 4 });

    const { err } = await start();

    expect(err).not.toContain(CONVENTIONS_PATH);
  });

  it("warns once and names `init` for a document an older pipeline left", async () => {
    write(CONVENTIONS_PATH, conventionsDoc("0.3.0"));
    tracker.addIssue({ number: 4 });

    const { code, err, out } = await start();

    expect(err).toContain("warning:");
    expect(err).toContain("0.3.0");
    expect(err).toContain("ticket-runner init");
    expect(err.split("\n").filter((line) => line.includes(CONVENTIONS_PATH))).toHaveLength(1);
    // Warned, and then the Run did exactly what it came for.
    expect(out).toContain("merged   #4");
    expect(code).toBe(0);
  });

  it("warns and names the upgrade for a document a newer pipeline left", async () => {
    write(CONVENTIONS_PATH, conventionsDoc("0.5.0"));
    tracker.addIssue({ number: 4 });

    const { code, err, out } = await start();

    expect(err).toContain("0.5.0");
    expect(err).toContain("upgrade");
    expect(err).not.toContain("ticket-runner init");
    expect(out).toContain("merged   #4");
    expect(code).toBe(0);
  });

  it("rewrites nothing it warned about", async () => {
    const older = conventionsDoc("0.3.0");
    write(CONVENTIONS_PATH, older);
    tracker.addIssue({ number: 4 });

    await start();

    expect(readFileSync(join(repoRoot, CONVENTIONS_PATH), "utf8")).toBe(older);
  });
});
