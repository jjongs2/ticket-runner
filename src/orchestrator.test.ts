import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { processTicket } from "./orchestrator.js";
import type { TicketOutcome } from "./orchestrator.js";
import { FakeAgentRunner, FakeTracker, FakeWorkspace, stageResult } from "./testing/fakes.js";

const TICKET = 2;
const BRANCH = "agent/2-skeleton-one-ticket-end-to-end";
const WORKTREE = "/repo/.worktrees/ticket-2";
const URL = "https://github.com/acme/repo/issues/2";

function config(overrides: Partial<Config> = {}): Config {
  return {
    checks: ["npm test", "npm run typecheck"],
    gates: { checks: true, ci: true },
    stages: {
      implement: { model: "claude-opus-5", maxTurns: 300, maxMinutes: 60, extraPrompt: "" },
      verify: { model: "claude-opus-5", maxTurns: 80, maxMinutes: 20, extraPrompt: "" },
      fix: { model: "claude-opus-5", maxTurns: 150, maxMinutes: 40, extraPrompt: "" },
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
    ...overrides,
  };
}

function verdictResult(
  criteria: { text: string; status: string; evidence: string }[],
  pass = true,
) {
  return { criteria, pass };
}

const PASSING_VERDICT = verdictResult([
  { text: "it works", status: "met", evidence: "npm test is green" },
]);

const MIXED_VERDICT = verdictResult([
  { text: "it works", status: "met", evidence: "npm test is green" },
  {
    text: "the docs say so",
    status: "unverifiable",
    evidence: "the docs are not readable from here",
  },
]);

let tracker: FakeTracker;
let runner: FakeAgentRunner;
let workspace: FakeWorkspace;

beforeEach(() => {
  tracker = new FakeTracker();
  tracker.addIssue({ number: TICKET, title: "Skeleton: one Ticket end to end", url: URL });
  runner = new FakeAgentRunner({
    verify: stageResult({ result: PASSING_VERDICT }),
  });
  workspace = new FakeWorkspace();
});

function run(overrides: Partial<Config> = {}): Promise<TicketOutcome> {
  return processTicket(
    {
      tracker,
      runner,
      workspace,
      config: config(overrides),
      repoRoot: "/repo",
      runId: "run-1",
    },
    TICKET,
  );
}

describe("the happy path", () => {
  it("takes one Ticket from claimed to merged", async () => {
    const outcome = await run();

    expect(outcome).toEqual({
      outcome: "merged",
      ticket: TICKET,
      title: "Skeleton: one Ticket end to end",
      branch: BRANCH,
      pullRequest: 100,
    });
    expect(tracker.pullRequest(100).merged).toBe(true);
  });

  it("runs the Stages in order, implement then verify", async () => {
    await run();

    expect(runner.stages()).toEqual(["implement", "verify"]);
  });

  it("claims the Ticket before any other side effect", async () => {
    await run();

    expect(tracker.calls.slice(0, 3)).toEqual([
      `assign:${TICKET}:pipeline-user`,
      `addLabel:${TICKET}:in-progress`,
      `removeLabel:${TICKET}:ready-for-agent`,
    ]);
    expect(workspace.calls.indexOf(`createWorktree:${BRANCH}`)).toBe(0);
  });

  it("implements in a worktree on a fresh branch named after the Ticket", async () => {
    await run();

    expect(workspace.calls[0]).toBe(`createWorktree:${BRANCH}`);
    expect(runner.requests[0]?.cwd).toBe(WORKTREE);
  });

  it("squash-merges, pulls main and cleans the worktree and remote branch up", async () => {
    await run();

    expect(tracker.calls).toContain("squashMerge:100");
    expect(workspace.calls.slice(-3)).toEqual([
      "pullMain",
      `removeWorktree:${BRANCH}`,
      `deleteRemoteBranch:${BRANCH}`,
    ]);
  });

  it("opens a PR that closes the Ticket and summarises the Verdict", async () => {
    await run();
    const pr = tracker.pullRequest(100);

    expect(pr.draft).toBe(false);
    expect(pr.head).toBe(BRANCH);
    expect(pr.title).toBe("feat(cli): do the thing");
    expect(pr.body.split("\n")[0]).toBe(`Closes #${TICKET}`);
    expect(pr.body).toContain("**Verdict:** 1 met · 0 unmet · 0 unverifiable");
  });

  it("clears in-progress after the merge and keeps the assignee as the record", async () => {
    await run();

    expect(tracker.issue(TICKET).labels).toEqual([]);
    expect(tracker.issue(TICKET).assignees).toEqual(["pipeline-user"]);
    expect(tracker.comments).toEqual([]);
  });
});

describe("the pull request title and the squash commit", () => {
  it("takes the title from the first commit subject, without its Ticket reference", async () => {
    workspace.commits = [
      "feat(tracker): compose the squash commit (#2)",
      "docs: describe the new rule (#2)",
    ];

    await run();

    expect(tracker.pullRequest(100).title).toBe("feat(tracker): compose the squash commit");
  });

  it("falls back to the Ticket title when the first subject is not in the convention", async () => {
    workspace.commits = ["wip", "feat(cli): do the thing (#2)"];

    await run();

    expect(tracker.pullRequest(100).title).toBe("Skeleton: one Ticket end to end");
  });

  it("merges with the PR title as the subject", async () => {
    workspace.commits = ["fix(cli): stop double-counting (#2)"];

    await run();
    const pr = tracker.pullRequest(100);

    expect(pr.squashCommit?.subject).toBe(pr.title);
    expect(pr.squashCommit?.subject).toBe("fix(cli): stop double-counting");
  });

  it("composes a body of Closes, the Verdict counts and every branch commit in order", async () => {
    workspace.commits = [
      "feat(cli): do the thing (#2)",
      "test(cli): cover the thing (#2)",
      "docs: write it down (#2)",
    ];
    runner.queue("verify", stageResult({ result: MIXED_VERDICT }));

    await run();

    expect(tracker.pullRequest(100).squashCommit?.body).toBe(
      [
        `Closes #${TICKET}`,
        "",
        "Verdict: 1 met · 0 unmet · 1 unverifiable",
        "",
        "- feat(cli): do the thing (#2)",
        "- test(cli): cover the thing (#2)",
        "- docs: write it down (#2)",
        "",
      ].join("\n"),
    );
  });

  it("keeps the evidence out of the commit: no HTML and no details block", async () => {
    runner.queue("verify", stageResult({ result: MIXED_VERDICT }));

    await run();
    const commit = tracker.pullRequest(100).squashCommit;

    expect(commit?.body).not.toContain("<");
    expect(commit?.body).not.toContain("details");
    expect(commit?.body).not.toContain("the docs are not readable from here");
  });

  it("reads the branch commits after the rebase, so the merge lists what lands", async () => {
    await run();

    expect(workspace.calls.indexOf("rebaseOnMain")).toBeLessThan(
      workspace.calls.lastIndexOf(`commitSubjects:${BRANCH}`),
    );
  });

  it("keeps the Ticket title on a draft PR the hand-off opens, which merges nothing", async () => {
    workspace.commits = [];

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off" });
    expect(tracker.pullRequest(100).draft).toBe(true);
    expect(tracker.pullRequest(100).title).toBe("Skeleton: one Ticket end to end");
  });

  it("leaves the title of a PR that was already open when the hand-off came", async () => {
    tracker.ci = { state: "none" };

    await run();

    expect(tracker.pullRequest(100).draft).toBe(true);
    expect(tracker.pullRequest(100).title).toBe("feat(cli): do the thing");
  });
});

describe("Stage invocation", () => {
  it("passes each Stage its configured model, turn and time limits", async () => {
    await run();

    expect(runner.requests[0]).toMatchObject({
      stage: "implement",
      model: "claude-opus-5",
      maxTurns: 300,
      maxMinutes: 60,
      permissionMode: "auto",
    });
    expect(runner.requests[1]).toMatchObject({
      stage: "verify",
      maxTurns: 80,
      maxMinutes: 20,
    });
  });

  it("keys the log directory by run id and Ticket number", async () => {
    await run();

    for (const request of runner.requests) {
      expect(request.logDir).toBe(`/repo/.agent-pipeline/runs/run-1/${TICKET}`);
    }
  });

  it("starts the implement prompt with the skill and the full issue URL", async () => {
    await run();

    expect(runner.prompts("implement")[0]?.split("\n")[0]).toBe(
      `/mattpocock-skills:implement ${URL}`,
    );
  });

  it("appends the configured extra prompt to the implement Stage", async () => {
    await run({
      stages: {
        ...config().stages,
        implement: { ...config().stages.implement, extraPrompt: "Use table-driven tests." },
      },
    });

    expect(runner.prompts("implement")[0]).toContain("Use table-driven tests.");
  });

  it("asks the verify Stage for structured output and nothing else does", async () => {
    await run();

    expect(runner.requests[0]?.jsonSchema).toBeUndefined();
    expect(runner.requests[1]?.jsonSchema).toBeDefined();
  });
});

describe("implement Stage failures", () => {
  it("hands off when the Stage itself fails", async () => {
    runner.queue("implement", { ok: false, failure: "nonzero-exit" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "implement" });
    expect(runner.stages()).toEqual(["implement"]);
  });

  it("names a rate limit as the failure rather than hiding it", async () => {
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off" });
    expect(handoffBody()).toMatch(/rate limit/i);
  });

  it("treats a Stage that left no new commits as a failure", async () => {
    workspace.commits = [];

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "implement" });
    expect(handoffBody()).toMatch(/no new commits/i);
    expect(runner.stages()).toEqual(["implement"]);
  });
});

describe("Checks", () => {
  it("runs every configured Check in the worktree after implement", async () => {
    await run();

    expect(workspace.ranChecks).toEqual([
      { command: "npm test", cwd: WORKTREE },
      { command: "npm run typecheck", cwd: WORKTREE },
    ]);
  });

  it("stops at the first failing Check and hands the Ticket off with its output", async () => {
    workspace.failCheck("npm test", "FAIL src/a.test.ts");

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "checks" });
    expect(workspace.ranChecks.map((c) => c.command)).toEqual(["npm test"]);
    expect(handoffBody()).toContain("FAIL src/a.test.ts");
    expect(runner.stages()).toEqual(["implement"]);
  });
});

describe("the verify Stage", () => {
  it("discards whatever the Stage left behind in the worktree", async () => {
    await run();

    expect(workspace.calls).toContain(`discardChanges:${WORKTREE}`);
  });

  it("discards scratch files even when the Stage failed", async () => {
    runner.queue("verify", { ok: false, failure: "timed-out" });

    await run();

    expect(workspace.calls).toContain(`discardChanges:${WORKTREE}`);
  });

  it("ignores the agent's pass flag when a criterion is unmet", async () => {
    runner.queue("verify", {
      result: verdictResult(
        [
          { text: "it works", status: "met", evidence: "green" },
          { text: "it is documented", status: "unmet", evidence: "no docs" },
        ],
        true,
      ),
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "verify" });
    expect(handoffBody()).toContain("it is documented");
  });

  it("ignores the agent's pass flag when nothing is unmet", async () => {
    runner.queue("verify", {
      result: verdictResult([{ text: "it works", status: "met", evidence: "green" }], false),
    });

    expect(await run()).toMatchObject({ outcome: "merged" });
  });

  it("merges when the only doubt is an unverifiable criterion", async () => {
    runner.queue("verify", {
      result: verdictResult([
        { text: "it works", status: "met", evidence: "green" },
        { text: "it reads well", status: "unverifiable", evidence: "taste" },
      ]),
    });

    expect(await run()).toMatchObject({ outcome: "merged" });
  });

  it("hands off a Verdict that is nothing but unverifiable criteria", async () => {
    runner.queue("verify", {
      result: verdictResult([{ text: "it reads well", status: "unverifiable", evidence: "taste" }]),
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "verify" });
    expect(handoffBody()).toMatch(/unverifiable/i);
  });

  it("hands off when the Stage returned no usable Verdict", async () => {
    runner.queue("verify", { result: { nonsense: true } });

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "verify" });
  });
});

describe("rebase", () => {
  it("rebases on main before opening the PR", async () => {
    await run();

    expect(workspace.calls.indexOf("rebaseOnMain")).toBeLessThan(
      workspace.calls.indexOf(`push:${BRANCH}`),
    );
  });

  it("hands off on a conflict, with the conflicting paths as evidence", async () => {
    workspace.rebase = { ok: false, conflict: "CONFLICT (content): src/cli.ts" };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "rebase" });
    expect(handoffBody()).toContain("CONFLICT (content): src/cli.ts");
  });
});

describe("CI", () => {
  it("waits for the PR checks up to the configured timeout", async () => {
    await run({ ciTimeoutMinutes: 5 });

    expect(tracker.ciWaits).toEqual([{ pullRequest: 100, timeoutMs: 5 * 60_000 }]);
  });

  it("hands off when a check fails", async () => {
    tracker.ci = { state: "failed", summary: "checks/build failed" };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "ci" });
    expect(handoffBody()).toContain("checks/build failed");
  });

  it("hands off when the PR has no checks at all", async () => {
    tracker.ci = { state: "none" };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "ci" });
    expect(handoffBody()).toMatch(/no checks/i);
  });

  it("hands off when CI does not finish in time", async () => {
    tracker.ci = { state: "timed-out" };

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "ci" });
  });

  it("merges a PR with no checks when the CI gate is off", async () => {
    tracker.ci = { state: "none" };

    expect(await run({ gates: { checks: true, ci: false } })).toMatchObject({
      outcome: "merged",
    });
  });

  it("still refuses a red PR when the CI gate is off", async () => {
    tracker.ci = { state: "failed", summary: "checks/build failed" };

    expect(await run({ gates: { checks: true, ci: false } })).toMatchObject({
      outcome: "handed-off",
      stage: "ci",
    });
  });

  it("still refuses a PR whose checks never finished when the CI gate is off", async () => {
    tracker.ci = { state: "timed-out" };

    expect(await run({ gates: { checks: true, ci: false } })).toMatchObject({
      outcome: "handed-off",
      stage: "ci",
    });
  });
});

describe("failures the pipeline did not expect", () => {
  it("names the step it was on rather than blaming the merge", async () => {
    workspace.createWorktree = async () => {
      throw new Error("worktree path already exists");
    };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "setup" });
    expect(handoffBody()).toContain("worktree path already exists");
  });

  it("blames the PR step when the push fails", async () => {
    workspace.push = async () => {
      throw new Error("remote rejected");
    };

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "pr" });
  });

  it("reports a merged Ticket even when cleaning up afterwards fails", async () => {
    workspace.removeWorktree = async () => {
      throw new Error("worktree is locked");
    };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged", pullRequest: 100 });
    expect(tracker.pullRequest(100).merged).toBe(true);
    expect(tracker.comments).toEqual([]);
    expect(tracker.issue(TICKET).labels).toEqual([]);
  });
});

describe("hand-off", () => {
  beforeEach(() => {
    workspace.commits = [];
  });

  it("opens a draft PR, comments, relabels and unassigns", async () => {
    await run();

    expect(tracker.pullRequest(100).draft).toBe(true);
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-human"]);
    expect(tracker.issue(TICKET).assignees).toEqual([]);
    expect(handoffBody()).toContain(`Branch \`${BRANCH}\``);
    expect(handoffBody()).toContain(`worktree \`${WORKTREE}\``);
    expect(handoffBody()).toContain("PR #100 (draft)");
  });

  it("keeps the worktree and the branch for a human to pick up", async () => {
    await run();

    expect(workspace.worktrees.get(WORKTREE)).toBe(BRANCH);
    expect(workspace.calls).not.toContain(`removeWorktree:${BRANCH}`);
  });

  it("converts the existing PR to a draft rather than opening a second one", async () => {
    workspace.commits = ["feat(cli): do the thing (#2)"];
    tracker.ci = { state: "failed", summary: "checks/build failed" };

    await run();

    expect(tracker.pullRequests).toHaveLength(1);
    expect(tracker.pullRequest(100).draft).toBe(true);
    expect(tracker.calls).toContain("convertPullRequestToDraft:100");
  });

  it("still relabels when the draft PR cannot be opened", async () => {
    workspace.push = async () => {
      throw new Error("remote rejected");
    };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off" });
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-human"]);
    expect(handoffBody()).not.toContain("PR #");
  });

  it("never merges a handed-off Ticket", async () => {
    await run();

    expect(tracker.pullRequest(100).merged).toBe(false);
    expect(workspace.pulledMain).toBe(0);
  });
});

function handoffBody(): string {
  const comment = tracker.comments.at(-1);
  if (!comment) throw new Error("no hand-off comment was written");
  return comment.body;
}
