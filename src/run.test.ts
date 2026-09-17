import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import type { Pipeline } from "./orchestrator.js";
import { processRun } from "./run.js";
import { FakeAgentRunner, FakeTracker, FakeWorkspace, stageResult } from "./testing/fakes.js";

function config(): Config {
  return {
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

beforeEach(() => {
  tracker = new FakeTracker();
  runner = new FakeAgentRunner({ verify: stageResult({ result: PASSING_VERDICT }) });
  workspace = new FakeWorkspace();
  logged = [];
});

function pipeline(): Pipeline {
  return {
    tracker,
    runner,
    workspace,
    config: config(),
    repoRoot: "/repo",
    runId: "run-1",
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

    expect(result).toEqual({ outcomes: [], blocked: [] });
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
    expect(result.blocked).toEqual([4]);
  });

  it("includes a Ticket whose native blockers have all closed", async () => {
    tracker.addIssue({ number: 4 });
    tracker.openBlockers.set(4, 0);

    const result = await processRun(pipeline());

    expect(processed()).toEqual([4]);
    expect(result.blocked).toEqual([]);
  });

  it("ends the Run when every remaining candidate is blocked", async () => {
    for (const number of [4, 6]) {
      tracker.addIssue({ number });
      tracker.openBlockers.set(number, 1);
    }

    const result = await processRun(pipeline());

    expect(processed()).toEqual([]);
    expect(result.blocked).toEqual([4, 6]);
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
    expect(result.blocked).toEqual([]);
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

describe("a Ticket that throws", () => {
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
    expect(result.blocked).toEqual([]);
  });

  it("pulls main before the next Ticket's worktree is created", async () => {
    for (const number of [4, 5]) tracker.addIssue({ number });

    await processRun(pipeline());

    const pull = workspace.calls.indexOf("pullMain");
    expect(pull).toBeGreaterThan(-1);
    expect(pull).toBeLessThan(workspace.calls.indexOf("createWorktree:agent/5-ticket-5"));
  });
});
