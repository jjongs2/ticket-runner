import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Landing } from "./landing.js";
import { StandingNotes } from "./notes.js";
import type { Pipeline } from "./orchestrator.js";
import { type TicketState, statePath, writeTicketState } from "./resume.js";
import { processRun } from "./run.js";
import { StopSignal } from "./stop.js";
import { FakeAgentRunner, FakeTracker, FakeWorkspace, stageResult } from "./testing/fakes.js";
import { settle } from "./testing/settle.js";

function config(): Config {
  return {
    lanes: 1,
    checks: ["npm test"],
    gates: { checks: true, ci: true },
    stages: {
      implement: {
        model: "claude-opus-5-5",
        effort: "high",
        maxTurns: 300,
        maxMinutes: 60,
        extraPrompt: "",
      },
      verify: {
        model: "claude-opus-5-5",
        effort: "high",
        maxTurns: 80,
        maxMinutes: 20,
        extraPrompt: "",
      },
      fix: {
        model: "claude-opus-5-5",
        effort: "high",
        maxTurns: 150,
        maxMinutes: 40,
        extraPrompt: "",
      },
      conflict: {
        model: "claude-opus-5-5",
        effort: "high",
        maxTurns: 120,
        maxMinutes: 30,
        extraPrompt: "",
      },
    },
    permissionMode: "auto",
    ciTimeoutMinutes: 30,
    ciGraceMinutes: 5,
    checkTimeoutMinutes: 15,
    labels: {
      needsTriage: "needs-triage",
      needsInfo: "needs-info",
      readyForAgent: "ready-for-agent",
      readyForHuman: "ready-for-human",
      wontfix: "wontfix",
      inProgress: "in-progress",
    },
  };
}

/** The Version this Run is, as the CLI resolves it once and hands it down. */
const VERSION = "0.4.0+331d79c";

const PASSING_VERDICT = {
  criteria: [{ text: "it works", status: "met", evidence: "npm test is green" }],
  pass: true,
};

let tracker: FakeTracker;
let runner: FakeAgentRunner;
let workspace: FakeWorkspace;
let logged: string[];
/** A temporary repo root, because a claimed Ticket's State file is a real file. */
let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "agent-pipeline-run-"));
  tracker = new FakeTracker();
  runner = new FakeAgentRunner({ verify: stageResult({ result: PASSING_VERDICT }) });
  workspace = new FakeWorkspace();
  logged = [];
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

/** A Run with `lanes` Lanes, which is one unless the test is about the others. */
function pipeline(lanes = 1): Pipeline {
  return {
    tracker,
    runner,
    workspace,
    config: { ...config(), lanes },
    repoRoot,
    runId: "run-1",
    version: VERSION,
    baseBranch: "main",
    landing: new Landing(),
    standingNotes: new StandingNotes(),
    log: (line) => logged.push(line),
  };
}

/** The Tickets a Run took, in the order it took them. */
function processed(): number[] {
  return tracker.calls
    .filter((call) => call.startsWith("assign:"))
    .map((call) => Number.parseInt(call.split(":")[1] as string, 10));
}

/** Where this Ticket's worktree is, under the repo root the Run was given. */
function worktreeOf(ticket: number): string {
  return join(repoRoot, ".worktrees", `ticket-${ticket}`);
}

/** Exactly what a killed Run leaves: the Claim, the worktree, the State file. */
function stranded(ticket: number, overrides: Partial<TicketState> = {}): void {
  const state: TicketState = {
    ticket,
    branch: `agent/${ticket}-ticket-${ticket}`,
    state: "implemented",
    fixUsed: false,
    runId: "run-0",
    updatedAt: "2026-09-17T09:00:00.000Z",
    ...overrides,
  };
  tracker.addIssue({ number: ticket, assignees: ["pipeline-user"], labels: ["in-progress"] });
  workspace.worktrees.set(worktreeOf(ticket), state.branch);
  writeTicketState(repoRoot, state);
}

describe("draining the Frontier", () => {
  it("takes every unclaimed ready-for-agent Ticket, lowest number first", async () => {
    for (const number of [7, 4, 5]) tracker.addIssue({ number });

    const result = await processRun(pipeline());

    expect(processed()).toEqual([4, 5, 7]);
    expect(result.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "merged",
      "merged",
      "merged",
    ]);
  });

  it("leaves an issue without the ready-for-agent label alone", async () => {
    tracker.addIssue({ number: 4, labels: ["needs-triage"] });
    tracker.addIssue({ number: 5 });

    await processRun(pipeline());

    expect(processed()).toEqual([5]);
  });

  it("leaves a Ticket somebody else has already claimed alone", async () => {
    tracker.addIssue({ number: 4, assignees: ["octocat"] });
    tracker.addIssue({ number: 5 });

    await processRun(pipeline());

    expect(processed()).toEqual([5]);
  });

  it("does nothing when the Frontier is empty", async () => {
    const result = await processRun(pipeline());

    expect(result).toEqual({ outcomes: [], stop: { reason: "frontier", blocked: [] } });
    expect(runner.requests).toEqual([]);
  });

  it("processes one Ticket at a time, finishing each before claiming the next", async () => {
    for (const number of [4, 5]) tracker.addIssue({ number });

    await processRun(pipeline());

    expect(workspace.calls.filter((call) => call.startsWith("createWorktree"))).toEqual([
      "createWorktree:agent/4-ticket-4",
      "createWorktree:agent/5-ticket-5",
    ]);
    expect(tracker.calls.indexOf("squashMerge:100")).toBeLessThan(
      tracker.calls.indexOf("assign:5:pipeline-user"),
    );
  });

  it("runs each Ticket through the same claim-to-merge flow as `ticket <n>`", async () => {
    tracker.addIssue({ number: 4 });

    await processRun(pipeline());

    expect(runner.stages()).toEqual(["implement", "verify"]);
    expect(tracker.calls).toContain("addLabel:4:in-progress");
    expect(tracker.calls).toContain("removeLabel:4:ready-for-agent");
    expect(tracker.pullRequest(100).merged).toBe(true);
  });
});

describe("blocked candidates", () => {
  it("excludes a Ticket with at least one open native blocker", async () => {
    tracker.addIssue({ number: 4 });
    tracker.openBlockers.set(4, 1);
    tracker.addIssue({ number: 5 });

    const result = await processRun(pipeline());

    expect(processed()).toEqual([5]);
    expect(result.stop).toEqual({ reason: "frontier", blocked: [4] });
  });

  it("includes a Ticket whose native blockers have all closed", async () => {
    tracker.addIssue({ number: 4 });
    tracker.openBlockers.set(4, 0);

    const result = await processRun(pipeline());

    expect(processed()).toEqual([4]);
    expect(result.stop).toEqual({ reason: "frontier", blocked: [] });
  });

  it("ends the Run when every remaining candidate is blocked", async () => {
    for (const number of [4, 6]) {
      tracker.addIssue({ number });
      tracker.openBlockers.set(number, 1);
    }

    const result = await processRun(pipeline());

    expect(processed()).toEqual([]);
    expect(result.stop).toEqual({ reason: "frontier", blocked: [4, 6] });
    expect(runner.requests).toEqual([]);
  });
});

describe("candidates a guard rejected", () => {
  it("passes one over and takes the next Ticket", async () => {
    tracker.addIssue({ number: 4, body: "no criteria here" });
    tracker.addIssue({ number: 5 });

    const result = await processRun(pipeline());

    expect(processed()).toEqual([5]);
    expect(result.outcomes[0]).toEqual({
      outcome: "skipped",
      ticket: 4,
      title: "Ticket 4",
      reason: "no-criteria",
    });
  });

  it("does not meet the same rejected candidate twice in one Run", async () => {
    // Only the Spec loses its label, so the rest stay on the Frontier all Run.
    tracker.addIssue({ number: 4, body: "no criteria here" });

    const result = await processRun(pipeline());

    expect(result.outcomes).toHaveLength(1);
    expect(tracker.comments).toHaveLength(1);
  });

  it("reports every rejected candidate with its reason", async () => {
    tracker.addIssue({ number: 4, subIssues: 2 });
    tracker.addIssue({ number: 5, body: "- [ ] it works\n\nBlocked by: #99\n" });
    tracker.addIssue({ number: 6 });

    const result = await processRun(pipeline());

    expect(result.outcomes).toEqual([
      { outcome: "skipped", ticket: 4, title: "Ticket 4", reason: "spec" },
      { outcome: "skipped", ticket: 5, title: "Ticket 5", reason: "body-only-blockers" },
      expect.objectContaining({ outcome: "merged", ticket: 6 }),
    ]);
    expect(logged).toContain("#4 skipped · spec");
  });

  it("ends the Run when every candidate was rejected", async () => {
    for (const number of [4, 5]) tracker.addIssue({ number, body: "no criteria here" });

    const result = await processRun(pipeline());

    expect(processed()).toEqual([]);
    expect(runner.requests).toEqual([]);
    expect(result.stop).toEqual({ reason: "frontier", blocked: [] });
  });
});

describe("a Ticket that fails", () => {
  beforeEach(() => {
    for (const number of [4, 5]) tracker.addIssue({ number });
    workspace.failCheck("npm test", "1 test failed");
  });

  it("does not stop the Run", async () => {
    const result = await processRun(pipeline());

    expect(processed()).toEqual([4, 5]);
    expect(result.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "handed-off",
      "handed-off",
    ]);
  });

  it("is never picked up again, even when the relabel did not land", async () => {
    // A hand-off leaves the Ticket unassigned, so only the relabel keeps it off
    // the next Frontier. A Run must not spin on one when that write is lost.
    tracker.removeLabel = async () => {};

    const result = await processRun(pipeline());

    expect(processed()).toEqual([4, 5]);
    expect(result.outcomes).toHaveLength(2);
  });
});

describe("a Ticket the rate limit released", () => {
  beforeEach(() => {
    for (const number of [4, 5]) tracker.addIssue({ number });
    // Only the first implement Stage is stopped. Nothing else has to be: the
    // limit that stopped it would stop #5 too, so the Run never reaches it.
    runner.queue("implement", { ok: false, failure: "rate-limited" });
  });

  it("ends the Run, which claims no further Ticket", async () => {
    const result = await processRun(pipeline());

    expect(processed()).toEqual([4]);
    expect(result.outcomes.map((outcome) => outcome.outcome)).toEqual(["released"]);
    expect(workspace.calls).not.toContain("createWorktree:agent/5-ticket-5");
    expect(runner.stages()).toEqual(["implement"]);
  });

  it("says the limit ended the Run, not the Frontier", async () => {
    const result = await processRun(pipeline());

    expect(result.stop).toEqual({ reason: "rate-limited" });
    expect(logged).toContain("#4 stopped the Run · rate limit");
    // Every line a Run logs about a Ticket leads with that Ticket's number,
    // this one included, so interleaved Lanes stay readable one at a time.
    for (const line of logged) expect(line).toMatch(/^#\d+ /);
  });

  it("says nothing about a candidate a blocker held back as it stopped", async () => {
    tracker.addIssue({ number: 6 });
    tracker.openBlockers.set(6, 1);

    const result = await processRun(pipeline());

    // #6 is never judged, so the Run cannot say a blocker held it back all Run:
    // the stop it reports carries no candidates for the summary to skip.
    expect(result.stop).toEqual({ reason: "rate-limited" });
  });

  it("hands nothing over, which is the whole of what the exit code reads", async () => {
    const result = await processRun(pipeline());

    expect(result.outcomes.some((outcome) => outcome.outcome === "handed-off")).toBe(false);
  });

  it("leaves both Tickets to the Run started once the limit has reset", async () => {
    await processRun(pipeline());

    expect(tracker.issue(4).labels).toEqual(["ready-for-agent"]);
    expect(tracker.issue(5).labels).toEqual(["ready-for-agent"]);
    expect(tracker.issue(5).assignees).toEqual([]);
  });
});

describe("a Ticket that throws", () => {
  it("still reports the Notes it had already routed", async () => {
    tracker.addIssue({ number: 4 });
    runner.queue("implement", stageResult({ result: { notes: [{ note: "no cleanup" }] } }));
    // The Notes are routed first; the Ticket then fails, and the hand-off's own
    // writes are outside processTicket's net, so the tracker going down there
    // throws past the outcome the Notes would otherwise have ridden out on.
    // Only #4 refuses comments: the standing Notes issue has to take the Note
    // for there to be a routed one left to report.
    runner.queue("verify", stageResult({ ok: false, failure: "nonzero-exit" }));
    const comment = tracker.comment.bind(tracker);
    tracker.comment = async (number, body) => {
      if (number === 4) throw new Error("gh: connection reset");
      return await comment(number, body);
    };

    const result = await processRun(pipeline());

    expect(result.outcomes).toEqual([
      {
        outcome: "handed-off",
        ticket: 4,
        title: "Ticket 4",
        branch: "agent/4-ticket-4",
        // `take` catches what processTicket could not, so it can only blame setup.
        stage: "setup",
        failure: "gh: connection reset",
        notes: [
          { origin: 4, stage: "implement", issue: 200, opened: true, note: "no cleanup" },
        ],
      },
    ]);
  });

  it("is reported as handed off and the Run carries on", async () => {
    for (const number of [4, 5]) tracker.addIssue({ number });
    // The claim is outside processTicket's own hand-off net, so a tracker that
    // goes down there throws all the way out.
    const assign = tracker.assign.bind(tracker);
    tracker.assign = async (number, user) => {
      if (number === 4) throw new Error("gh: connection reset");
      return assign(number, user);
    };

    const result = await processRun(pipeline());

    expect(result.outcomes).toEqual([
      {
        outcome: "handed-off",
        ticket: 4,
        title: "Ticket 4",
        branch: "agent/4-ticket-4",
        stage: "setup",
        failure: "gh: connection reset",
        notes: [],
      },
      expect.objectContaining({ outcome: "merged", ticket: 5 }),
    ]);
    expect(logged).toContain("#4 failed outside the hand-off path: gh: connection reset");
  });

  it("is never retried in the same Run", async () => {
    tracker.addIssue({ number: 4 });
    tracker.assign = async () => {
      throw new Error("gh: connection reset");
    };

    const result = await processRun(pipeline());

    expect(result.outcomes).toHaveLength(1);
  });
});

describe("recomputing the Frontier", () => {
  it("picks up a Ticket the previous merge unblocked", async () => {
    tracker.addIssue({ number: 4 });
    tracker.addIssue({ number: 6 });
    tracker.openBlockers.set(6, 1);
    // #6's blocker closes the moment #4 merges.
    tracker.onSquashMerge = () => tracker.openBlockers.set(6, 0);

    const result = await processRun(pipeline());

    expect(processed()).toEqual([4, 6]);
    expect(result.stop).toEqual({ reason: "frontier", blocked: [] });
  });

  it("pulls the base branch before the next Ticket's worktree is created", async () => {
    for (const number of [4, 5]) tracker.addIssue({ number });

    await processRun(pipeline());

    const pull = workspace.calls.indexOf("pullBase");
    expect(pull).toBeGreaterThan(-1);
    expect(pull).toBeLessThan(workspace.calls.indexOf("createWorktree:agent/5-ticket-5"));
  });
});

/**
 * The sweep a Run does before it touches the Frontier: the Tickets a Run that
 * never came back left claimed, which nothing else would ever pick up.
 */
describe("stranded Tickets", () => {
  it("resumes one the Frontier could never have offered", async () => {
    stranded(4);

    const result = await processRun(pipeline());

    expect(result.outcomes).toEqual([expect.objectContaining({ outcome: "merged", ticket: 4 })]);
    expect(runner.stages()).toEqual(["verify"]);
    expect(workspace.calls).not.toContain("createWorktree:agent/4-ticket-4");
  });

  it("resumes every one of them, in ascending number, before computing the Frontier", async () => {
    stranded(9);
    stranded(4);
    tracker.addIssue({ number: 6 });

    const result = await processRun(pipeline());

    expect(result.outcomes.map((outcome) => outcome.ticket)).toEqual([4, 9, 6]);
    // The Frontier is not even asked for until the sweep is done.
    expect(tracker.calls.indexOf("listCandidates:ready-for-agent")).toBeGreaterThan(
      tracker.calls.indexOf("squashMerge:101"),
    );
  });

  it("works on the branch each State file names, not one derived from the title", async () => {
    stranded(4, { branch: "agent/4-what-it-was-called-then" });

    await processRun(pipeline());

    expect(workspace.pushes.map((push) => push.branch)).toEqual([
      "agent/4-what-it-was-called-then",
    ]);
  });

  it("keeps the Claim each one already has", async () => {
    stranded(4);

    await processRun(pipeline());

    expect(tracker.calls).not.toContain("assign:4:pipeline-user");
    expect(tracker.calls).not.toContain("addLabel:4:in-progress");
  });

  it("ends the Run when one it resumed is released, before the Frontier is computed", async () => {
    stranded(4);
    stranded(9);
    tracker.addIssue({ number: 6 });
    runner.queue("verify", { ok: false, failure: "rate-limited" });

    const result = await processRun(pipeline());

    expect(result.outcomes.map((outcome) => outcome.outcome)).toEqual(["released"]);
    expect(result.stop).toEqual({ reason: "rate-limited" });
    expect(tracker.issue(4).labels).toEqual(["ready-for-agent"]);
    // #9 keeps the Claim that makes it stranded, and its state keeps the work,
    // so the next Run sweeps it up exactly as this one found it.
    expect(tracker.issue(9).assignees).toEqual(["pipeline-user"]);
    expect(existsSync(statePath(repoRoot, 9))).toBe(true);
    // No Candidate is listed, let alone taken.
    expect(tracker.calls).not.toContain("listCandidates:ready-for-agent");
    expect(processed()).toEqual([]);
  });

  it("carries on into the Frontier when a resumed Ticket is handed off", async () => {
    stranded(4);
    workspace.failCheck("npm test", "1 test failed");
    tracker.addIssue({ number: 6 });

    const result = await processRun(pipeline());

    expect(result.outcomes.map((outcome) => [outcome.ticket, outcome.outcome])).toEqual([
      [4, "handed-off"],
      [6, "handed-off"],
    ]);
  });

  it("forgets one whose Ticket has closed rather than resuming it", async () => {
    tracker.addIssue({ number: 4, closed: true, assignees: ["pipeline-user"] });
    writeTicketState(repoRoot, {
      ticket: 4,
      branch: "agent/4-ticket-4",
      state: "implemented",
      fixUsed: false,
      runId: "run-0",
      updatedAt: "2026-09-17T09:00:00.000Z",
    });

    const result = await processRun(pipeline());

    expect(result.outcomes).toEqual([]);
    expect(existsSync(statePath(repoRoot, 4))).toBe(false);
    expect(logged).toContain("#4 has closed, so the state it left is gone");
  });

  it("leaves one somebody else now holds in place, and says so", async () => {
    stranded(4);
    tracker.issue(4).assignees = ["octocat"];

    const result = await processRun(pipeline());

    expect(result.outcomes).toEqual([]);
    expect(existsSync(statePath(repoRoot, 4))).toBe(true);
    expect(logged).toContain("#4 is resumable, but octocat holds it now");
  });

  it("leaves a released Ticket to the Frontier, which claims it the usual way", async () => {
    tracker.addIssue({ number: 4 });
    writeTicketState(repoRoot, {
      ticket: 4,
      branch: "agent/4-ticket-4",
      state: "implemented",
      fixUsed: false,
      runId: "run-0",
      updatedAt: "2026-09-17T09:00:00.000Z",
    });
    workspace.worktrees.set(worktreeOf(4), "agent/4-ticket-4");

    const result = await processRun(pipeline());

    expect(result.outcomes).toEqual([expect.objectContaining({ outcome: "merged", ticket: 4 })]);
    expect(processed()).toEqual([4]);
  });

  it("ends the Run when one resumed off the Frontier is released", async () => {
    // No Claim, so the Frontier offers #4 and the Run resumes it from its state.
    tracker.addIssue({ number: 4 });
    writeTicketState(repoRoot, {
      ticket: 4,
      branch: "agent/4-ticket-4",
      state: "implemented",
      fixUsed: false,
      runId: "run-0",
      updatedAt: "2026-09-17T09:00:00.000Z",
    });
    workspace.worktrees.set(worktreeOf(4), "agent/4-ticket-4");
    tracker.addIssue({ number: 6 });
    runner.queue("verify", { ok: false, failure: "rate-limited" });

    const result = await processRun(pipeline());

    expect(result.outcomes.map((outcome) => [outcome.ticket, outcome.outcome])).toEqual([
      [4, "released"],
    ]);
    expect(result.stop).toEqual({ reason: "rate-limited" });
    expect(processed()).toEqual([4]);
  });

  it("takes one whose worktree is gone from the top, in place", async () => {
    stranded(4);
    workspace.worktrees.delete(worktreeOf(4));

    const result = await processRun(pipeline());

    expect(result.outcomes).toEqual([expect.objectContaining({ outcome: "merged", ticket: 4 })]);
    expect(workspace.calls).toContain("createWorktree:agent/4-ticket-4");
    expect(runner.stages()).toEqual(["implement", "verify"]);
  });

  it("reports a resumed Ticket that throws with the branch its state named", async () => {
    stranded(4, { branch: "agent/4-what-it-was-called-then" });
    tracker.comment = async () => {
      throw new Error("gh: connection reset");
    };
    runner.queue("verify", stageResult({ ok: false, failure: "nonzero-exit" }));

    const result = await processRun(pipeline());

    expect(result.outcomes).toEqual([
      {
        outcome: "handed-off",
        ticket: 4,
        title: "Ticket 4",
        branch: "agent/4-what-it-was-called-then",
        stage: "setup",
        failure: "gh: connection reset",
        notes: [],
      },
    ]);
  });

  it("changes nothing for a Run on a checkout that has nothing recorded", async () => {
    for (const number of [4, 5]) tracker.addIssue({ number });

    const result = await processRun(pipeline());

    expect(processed()).toEqual([4, 5]);
    expect(result.outcomes.map((outcome) => outcome.outcome)).toEqual(["merged", "merged"]);
  });
});

/**
 * A Run with more than one Lane. Everything above holds a Run to the one Lane a
 * Target gets by default, which is what says the Lane count changed nothing for
 * the Targets that never asked for it; these say what the other Lanes do.
 */
describe("Lanes", () => {
  it("starts a Ticket in every Lane before any of them ends", async () => {
    for (const number of [4, 5, 6]) tracker.addIssue({ number });
    const implementing = runner.holds("implement");

    const run = processRun(pipeline(3));
    await implementing.started();
    await settle();

    expect(runner.stages()).toEqual(["implement", "implement", "implement"]);
    expect(processed()).toEqual([4, 5, 6]);

    implementing.release();
    const result = await run;

    expect(result.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "merged",
      "merged",
      "merged",
    ]);
  });

  it("holds no more Tickets at once than it has Lanes", async () => {
    for (const number of [4, 5, 6]) tracker.addIssue({ number });
    const implementing = runner.holds("implement");

    const run = processRun(pipeline(2));
    await implementing.started();
    await settle();

    expect(processed()).toEqual([4, 5]);

    implementing.release();
    const result = await run;

    expect(result.outcomes).toHaveLength(3);
  });

  it("refills a Lane the moment its Ticket ends, whatever the others are doing", async () => {
    for (const number of [4, 5, 6]) tracker.addIssue({ number });
    // #4 is handed off at its implement Stage, so its Lane frees while #5 is
    // still parked in a Stage of its own.
    runner.queue("implement", { ok: false, failure: "nonzero-exit" });
    const verifying = runner.holds("verify");

    const run = processRun(pipeline(2));
    await verifying.started();
    await settle();

    expect(processed()).toEqual([4, 5, 6]);

    verifying.release();
    const result = await run;

    expect(result.outcomes.map((outcome) => [outcome.ticket, outcome.outcome])).toEqual([
      [4, "handed-off"],
      [5, "merged"],
      [6, "merged"],
    ]);
  });

  it("takes a Ticket a busy Lane's Ticket blocks only once that Lane has merged", async () => {
    tracker.addIssue({ number: 4 });
    tracker.addIssue({ number: 6 });
    tracker.openBlockers.set(6, 1);
    tracker.onSquashMerge = () => tracker.openBlockers.set(6, 0);
    // #4 parked with its pull request open, which is as far as a Lane gets
    // without merging: two free Lanes, and #6 blocked by what is in this one.
    const ci = tracker.holdsCi();

    const run = processRun(pipeline(3));
    await ci.started();
    await settle();

    expect(processed()).toEqual([4]);

    ci.release();
    const result = await run;

    expect(processed()).toEqual([4, 6]);
    expect(tracker.calls.indexOf("assign:6:pipeline-user")).toBeGreaterThan(
      tracker.calls.indexOf("squashMerge:100"),
    );
    // The last Frontier the Run computed is the one the summary reports, and by
    // then nothing was held back.
    expect(result.stop).toEqual({ reason: "frontier", blocked: [] });
  });

  it("fills every Lane that came back in the same pass", async () => {
    for (const number of [4, 5, 6, 7]) tracker.addIssue({ number });
    // Every Ticket is handed off at its implement Stage, so the two Lanes of a
    // pair come back together rather than one merge apart.
    for (let i = 0; i < 4; i += 1) {
      runner.queue("implement", { ok: false, failure: "nonzero-exit" });
    }

    const result = await processRun(pipeline(2));

    expect(result.outcomes.map((outcome) => outcome.ticket)).toEqual([4, 5, 6, 7]);
    // Three Frontiers and no more: the one that filled both Lanes, the one that
    // refilled both, and the one that found nothing left to take.
    expect(tracker.calls.filter((call) => call === "listCandidates:ready-for-agent")).toHaveLength(
      3,
    );
  });

  it("fills its Lanes from the stranded Tickets before it asks for the Frontier", async () => {
    stranded(4);
    stranded(9);
    tracker.addIssue({ number: 6 });
    const verifying = runner.holds("verify");

    const run = processRun(pipeline(2));
    await verifying.started();
    await settle();

    expect(tracker.calls).not.toContain("listCandidates:ready-for-agent");
    expect(processed()).toEqual([]);

    verifying.release();
    const result = await run;

    expect(result.outcomes.map((outcome) => outcome.ticket)).toEqual([4, 9, 6]);
  });

  it("starts a Frontier Ticket in one Lane while a stranded Ticket holds another", async () => {
    stranded(4);
    tracker.addIssue({ number: 6 });
    const verifying = runner.holds("verify");

    const run = processRun(pipeline(2));
    await verifying.started();
    await settle();

    expect(processed()).toEqual([6]);

    verifying.release();
    const result = await run;

    expect(result.outcomes.map((outcome) => outcome.ticket)).toEqual([4, 6]);
  });

  it("offers a Ticket it has already taken to no second Lane", async () => {
    for (const number of [4, 5]) tracker.addIssue({ number });
    workspace.failCheck("npm test", "1 test failed");
    // A hand-off leaves the Ticket unassigned, so only the relabel keeps it off
    // the next Frontier — and with Lanes there is a Frontier per refill.
    tracker.removeLabel = async () => {};

    const result = await processRun(pipeline(3));

    expect(processed()).toEqual([4, 5]);
    expect(result.outcomes).toHaveLength(2);
  });

  it("fills no Lane after a Release, and waits for the ones still busy", async () => {
    for (const number of [4, 5, 6]) tracker.addIssue({ number });
    runner.queue("implement", { ok: false, failure: "rate-limited" });
    const verifying = runner.holds("verify");

    let ended = false;
    const run = processRun(pipeline(2)).then((result) => {
      ended = true;
      return result;
    });
    await verifying.started();
    await settle();

    // The Release has happened and its Lane is free, and #6 is left where it is.
    expect(processed()).toEqual([4, 5]);
    expect(workspace.calls).not.toContain("createWorktree:agent/6-ticket-6");
    expect(ended).toBe(false);

    verifying.release();
    const result = await run;

    expect(result.outcomes.map((outcome) => [outcome.ticket, outcome.outcome])).toEqual([
      [4, "released"],
      [5, "merged"],
    ]);
    expect(result.stop).toEqual({ reason: "rate-limited" });
    expect(logged).toContain("#4 stopped the Run · rate limit");
  });

  it("says the limit stopped the Run once, however many Lanes were released", async () => {
    for (const number of [4, 5]) tracker.addIssue({ number });
    runner.queue("implement", { ok: false, failure: "rate-limited" });
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    const result = await processRun(pipeline(2));

    expect(result.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "released",
      "released",
    ]);
    expect(logged.filter((line) => line.endsWith("stopped the Run · rate limit"))).toEqual([
      "#4 stopped the Run · rate limit",
    ]);
  });

  it("waits for a busy Lane rather than ending on an empty Frontier", async () => {
    for (const number of [4, 5]) tracker.addIssue({ number });
    // #4's implement Stage passes and parks at verify; #5's fails, so its Lane
    // frees while the Frontier the refill computes has nothing left on it.
    runner.queue("implement", {});
    runner.queue("implement", { ok: false, failure: "nonzero-exit" });
    const verifying = runner.holds("verify");

    let ended = false;
    const run = processRun(pipeline(2)).then((result) => {
      ended = true;
      return result;
    });
    await verifying.started();
    await settle();

    expect(ended).toBe(false);

    verifying.release();
    const result = await run;

    // Completion order, not the order the Lanes were filled in.
    expect(result.outcomes.map((outcome) => [outcome.ticket, outcome.outcome])).toEqual([
      [5, "handed-off"],
      [4, "merged"],
    ]);
    expect(result.stop).toEqual({ reason: "frontier", blocked: [] });
  });

  it("reports the candidates the last Frontier it computed held back", async () => {
    tracker.addIssue({ number: 4 });
    for (const number of [7, 9]) {
      tracker.addIssue({ number });
      tracker.openBlockers.set(number, 1);
    }
    // #7's blocker closes with #4, so the first Frontier this Run computed held
    // back two candidates and the last held back one.
    tracker.onSquashMerge = (pullRequest) => {
      if (pullRequest === 100) tracker.openBlockers.set(7, 0);
    };

    const result = await processRun(pipeline(3));

    expect(processed()).toEqual([4, 7]);
    expect(result.stop).toEqual({ reason: "frontier", blocked: [9] });
  });

  it("waits for the busy Lanes before it throws a Frontier it could not list", async () => {
    for (const number of [4, 5]) tracker.addIssue({ number });
    const listed = tracker.listCandidates.bind(tracker);
    let listings = 0;
    tracker.listCandidates = async (label) => {
      listings += 1;
      if (listings > 1) throw new Error("gh: connection reset");
      return await listed(label);
    };

    await expect(processRun(pipeline(2))).rejects.toThrow("gh: connection reset");

    // Both Lanes were filled from the one Frontier that listed, and neither was
    // abandoned mid-Ticket to report that `gh` had gone down.
    expect(tracker.pullRequest(100).merged).toBe(true);
    expect(tracker.pullRequest(101).merged).toBe(true);
  });
});

/**
 * A Run a human stopped. A Release already stops a Run filling Lanes, so what
 * these say is the part a Stop does differently: it can arrive with no Lane
 * busy at all, it holds the Stranded Tickets back as well as the Frontier, and
 * it leaves the board untouched.
 */
describe("a Run a human stopped", () => {
  const AT = new Date("2026-09-20T22:07:13.000Z");

  /** The lines a Stop is answered with, which should never be more than one. */
  function stopLines(): string[] {
    return logged.filter((line) => line.endsWith("· stopped"));
  }

  it("lets the busy Lane finish its Ticket and claims nothing after it", async () => {
    for (const number of [4, 5]) tracker.addIssue({ number });
    const implementing = runner.holds("implement");
    const stopping = new StopSignal();

    const run = processRun(pipeline(), stopping);
    await implementing.started();
    await settle();
    stopping.request(AT);
    implementing.release();
    const result = await run;

    expect(processed()).toEqual([4]);
    expect(result.outcomes).toEqual([expect.objectContaining({ outcome: "merged", ticket: 4 })]);
    expect(result.stop).toEqual({
      reason: "stopped",
      at: "2026-09-20T22:07:13.000Z",
      busy: [4],
    });
  });

  it("logs one line leading with the Tickets its Lanes held at that moment", async () => {
    for (const number of [4, 5, 6]) tracker.addIssue({ number });
    const implementing = runner.holds("implement");
    const stopping = new StopSignal();

    const run = processRun(pipeline(2), stopping);
    await implementing.started();
    await settle();
    stopping.request(AT);
    implementing.release();
    await run;

    expect(stopLines()).toEqual(["#4 #5 left to finish · stopped"]);
  });

  it("answers a second SIGTERM with nothing, and goes on finishing", async () => {
    tracker.addIssue({ number: 4 });
    const implementing = runner.holds("implement");
    const stopping = new StopSignal();

    const run = processRun(pipeline(), stopping);
    await implementing.started();
    await settle();
    stopping.request(AT);
    stopping.request(new Date("2026-09-20T22:09:00.000Z"));
    implementing.release();
    const result = await run;

    expect(stopLines()).toEqual(["#4 left to finish · stopped"]);
    expect(result.outcomes).toEqual([expect.objectContaining({ outcome: "merged", ticket: 4 })]);
    // The Stop the Run reports is the first one, not the impatient second.
    expect(result.stop).toEqual({
      reason: "stopped",
      at: "2026-09-20T22:07:13.000Z",
      busy: [4],
    });
  });

  it("ends without claiming anything when no Lane is busy", async () => {
    for (const number of [4, 5]) tracker.addIssue({ number });
    const stopping = new StopSignal();
    stopping.request(AT);

    const result = await processRun(pipeline(), stopping);

    expect(result.outcomes).toEqual([]);
    expect(result.stop).toEqual({ reason: "stopped", at: "2026-09-20T22:07:13.000Z", busy: [] });
    expect(stopLines()).toEqual(["nothing left to finish · stopped"]);
    expect(runner.requests).toEqual([]);
    // No Candidate listed, and nothing written on GitHub either: a Stop is not
    // news any Ticket has to be told.
    expect(tracker.calls).toEqual([]);
    expect(tracker.comments).toEqual([]);
  });

  it("fills no Lane from a Frontier that was listed as the Stop arrived", async () => {
    for (const number of [4, 5]) tracker.addIssue({ number });
    const stopping = new StopSignal();
    const listed = tracker.listCandidates.bind(tracker);
    tracker.listCandidates = async (label) => {
      const candidates = await listed(label);
      // The one moment the Run has already committed to filling a Lane from
      // what comes back, and the Frontier in its hand is one it may not take.
      stopping.request(AT);
      return candidates;
    };

    const result = await processRun(pipeline(2), stopping);

    expect(processed()).toEqual([]);
    expect(runner.requests).toEqual([]);
    expect(result.stop).toEqual({ reason: "stopped", at: "2026-09-20T22:07:13.000Z", busy: [] });
  });

  it("takes no Stranded Ticket either, and leaves every one of them as it is", async () => {
    stranded(4);
    stranded(9);
    const stopping = new StopSignal();
    stopping.request(AT);

    const result = await processRun(pipeline(2), stopping);

    expect(result.outcomes).toEqual([]);
    expect(runner.requests).toEqual([]);
    expect(tracker.issue(4).assignees).toEqual(["pipeline-user"]);
    expect(existsSync(statePath(repoRoot, 4))).toBe(true);
    expect(existsSync(statePath(repoRoot, 9))).toBe(true);
  });

  it("leaves the Ticket it was finishing on the board exactly as a merge does", async () => {
    tracker.addIssue({ number: 4 });
    const implementing = runner.holds("implement");
    const stopping = new StopSignal();

    const run = processRun(pipeline(), stopping);
    await implementing.started();
    await settle();
    stopping.request(AT);
    implementing.release();
    await run;

    expect(tracker.pullRequest(100).merged).toBe(true);
    expect(existsSync(statePath(repoRoot, 4))).toBe(false);
    expect(tracker.calls).not.toContain("addLabel:4:ready-for-human");
  });

  it("hands nothing over, so the exit code is the one the outcomes earned", async () => {
    tracker.addIssue({ number: 4 });
    const stopping = new StopSignal();
    stopping.request(AT);

    const result = await processRun(pipeline(), stopping);

    expect(result.outcomes.some((outcome) => outcome.outcome === "handed-off")).toBe(false);
  });

  it("keeps the rate limit as the reason when a Release stopped the Run first", async () => {
    for (const number of [4, 5, 6]) tracker.addIssue({ number });
    runner.queue("implement", { ok: false, failure: "rate-limited" });
    const verifying = runner.holds("verify");
    const stopping = new StopSignal();

    const run = processRun(pipeline(2), stopping);
    await verifying.started();
    await settle();
    stopping.request(AT);
    verifying.release();
    const result = await run;

    // The Release is what stopped the Run; the Stop asked for what was already
    // happening, and is answered all the same.
    expect(result.stop).toEqual({ reason: "rate-limited" });
    expect(logged).toContain("#4 stopped the Run · rate limit");
    expect(stopLines()).toEqual(["#5 left to finish · stopped"]);
  });

  it("keeps the Stop as the reason when a Lane is released afterwards", async () => {
    tracker.addIssue({ number: 4 });
    runner.queue("verify", { ok: false, failure: "rate-limited" });
    const implementing = runner.holds("implement");
    const stopping = new StopSignal();

    const run = processRun(pipeline(), stopping);
    await implementing.started();
    await settle();
    stopping.request(AT);
    implementing.release();
    const result = await run;

    expect(result.outcomes).toEqual([expect.objectContaining({ outcome: "released", ticket: 4 })]);
    expect(result.stop).toEqual({
      reason: "stopped",
      at: "2026-09-20T22:07:13.000Z",
      busy: [4],
    });
    // The Release stopped nothing that the Stop had not stopped already.
    expect(logged).not.toContain("#4 stopped the Run · rate limit");
  });
});
