import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Landing } from "./landing.js";
import type { Pipeline } from "./orchestrator.js";
import { type TicketState, statePath, writeTicketState } from "./resume.js";
import { processRun } from "./run.js";
import { FakeAgentRunner, FakeTracker, FakeWorkspace, stageResult } from "./testing/fakes.js";

function config(): Config {
  return {
    lanes: 1,
    checks: ["npm test"],
    gates: { checks: true, ci: true },
    stages: {
      implement: { model: "claude-opus-5", maxTurns: 300, maxMinutes: 60, extraPrompt: "" },
      verify: { model: "claude-opus-5", maxTurns: 80, maxMinutes: 20, extraPrompt: "" },
      fix: { model: "claude-opus-5", maxTurns: 150, maxMinutes: 40, extraPrompt: "" },
      conflict: { model: "claude-opus-5", maxTurns: 120, maxMinutes: 30, extraPrompt: "" },
    },
    permissionMode: "auto",
    ciTimeoutMinutes: 30,
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

function pipeline(): Pipeline {
  return {
    tracker,
    runner,
    workspace,
    config: config(),
    repoRoot,
    runId: "run-1",
    baseBranch: "main",
    landing: new Landing(),
    log: (line) => logged.push(line),
  };
}

/** The Tickets a Run took, in the order it took them. */
function processed(): number[] {
  return tracker.calls
    .filter((call) => call.startsWith("assign:"))
    .map((call) => Number.parseInt(call.split(":")[1] as string, 10));
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
    runner.queue("verify", stageResult({ ok: false, failure: "nonzero-exit" }));
    tracker.comment = async () => {
      throw new Error("gh: connection reset");
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
  /** Where this Ticket's worktree is, under the repo root the Run was given. */
  const worktreeOf = (ticket: number) => join(repoRoot, ".worktrees", `ticket-${ticket}`);

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
