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

const UNMET_VERDICT = verdictResult([
  { text: "it works", status: "unmet", evidence: "npm test is red" },
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

  it("merges with the PR title plus the PR number as the subject", async () => {
    workspace.commits = ["fix(cli): stop double-counting (#2)"];

    await run();
    const pr = tracker.pullRequest(100);

    expect(pr.title).toBe("fix(cli): stop double-counting");
    expect(pr.squashCommit?.subject).toBe("fix(cli): stop double-counting (#100)");
  });

  it("carries the branch's co-authors into the squash commit", async () => {
    workspace.coAuthorList = ["Claude Opus 5 <noreply@anthropic.com>"];

    await run();

    expect(tracker.pullRequest(100).squashCommit?.body).toContain(
      "\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>\n",
    );
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
    // Neither the first pass nor the one behind the fix Stage reached the
    // typecheck: the Checks stop at the first command that fails.
    expect(workspace.ranChecks.map((c) => c.command)).toEqual(["npm test", "npm test"]);
    expect(handoffBody()).toContain("FAIL src/a.test.ts");
    expect(runner.stages()).toEqual(["implement", "fix"]);
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
    const claimsToPass = verdictResult(
      [
        { text: "it works", status: "met", evidence: "green" },
        { text: "it is documented", status: "unmet", evidence: "no docs" },
      ],
      true,
    );
    // Both passes, so the fix budget runs out on the same Verdict the agent
    // called a pass; the decision under test is the pipeline's, not the agent's.
    runner.queue("verify", { result: claimsToPass });
    runner.queue("verify", { result: claimsToPass });

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

describe("the fix Stage", () => {
  /** The one fix request a Ticket makes, which every test here expects to exist. */
  const fixRequest = () => {
    const request = runner.requests.find((r) => r.stage === "fix");
    if (!request) throw new Error("no fix Stage ran");
    return request;
  };

  it("retries a failing Check in the same worktree and merges on the second pass", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["implement", "fix", "verify"]);
    expect(fixRequest().cwd).toBe(WORKTREE);
    expect(workspace.calls.filter((call) => call.startsWith("createWorktree"))).toEqual([
      `createWorktree:${BRANCH}`,
    ]);
  });

  it("resumes at the Checks, running every one of them again", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");

    await run();

    expect(workspace.ranChecks.map((check) => check.command)).toEqual([
      "npm test",
      "npm test",
      "npm run typecheck",
    ]);
  });

  it("gives the fix Stage the failing Check and its output", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");

    await run();

    expect(runner.prompts("fix")[0]).toMatch(/a Check .*failed/i);
    expect(runner.prompts("fix")[0]).toContain("Check `npm test` failed");
    expect(runner.prompts("fix")[0]).toContain("FAIL src/a.test.ts");
  });

  it("retries an unmet criterion and merges on the second Verdict", async () => {
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify"]);
  });

  it("gives the fix Stage the unmet criteria with their evidence", async () => {
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));

    await run();

    expect(runner.prompts("fix")[0]).toMatch(/unmet Acceptance Criteria/i);
    expect(runner.prompts("fix")[0]).toContain("it works — npm test is red");
    expect(runner.prompts("fix")[0]).toMatch(/regression test/i);
  });

  it("retries a red CI without opening a second pull request", async () => {
    tracker.queueCi({ state: "failed", summary: "checks/build failed" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged", pullRequest: 100 });
    expect(tracker.pullRequests).toHaveLength(1);
    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify"]);
    expect(runner.prompts("fix")[0]).toMatch(/pull request check failed/i);
    expect(runner.prompts("fix")[0]).toContain("checks/build failed");
  });

  it("pushes the fixed branch and waits for CI a second time", async () => {
    tracker.queueCi({ state: "failed", summary: "checks/build failed" });

    await run();

    expect(workspace.pushes).toHaveLength(2);
    expect(tracker.ciWaits.map((wait) => wait.pullRequest)).toEqual([100, 100]);
  });

  it("merges the Verdict of the pass that succeeded, not the one that failed", async () => {
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));
    runner.queue("verify", stageResult({ result: MIXED_VERDICT }));

    await run();

    expect(tracker.pullRequest(100).squashCommit?.body).toContain(
      "Verdict: 1 met · 0 unmet · 1 unverifiable",
    );
  });

  it("takes its own model, turn and time limits, and its own extra prompt", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");

    await run({
      stages: {
        ...config().stages,
        fix: {
          model: "claude-sonnet-5",
          maxTurns: 12,
          maxMinutes: 9,
          extraPrompt: "Keep the diff small.",
        },
      },
    });

    expect(fixRequest()).toMatchObject({
      stage: "fix",
      model: "claude-sonnet-5",
      maxTurns: 12,
      maxMinutes: 9,
      permissionMode: "auto",
    });
    expect(runner.prompts("fix")[0]).toContain("Keep the diff small.");
  });

  it("asks the fix Stage for no structured output, and logs it beside the others", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");

    await run();

    expect(fixRequest().jsonSchema).toBeUndefined();
    expect(fixRequest().logDir).toBe(`/repo/.agent-pipeline/runs/run-1/${TICKET}`);
  });
});

describe("the fix budget", () => {
  it("is one: a Check that fails twice is handed off", async () => {
    workspace.failCheck("npm test", "FAIL src/a.test.ts");

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "checks" });
    expect(runner.stages()).toEqual(["implement", "fix"]);
    expect(handoffBody()).toContain("after the fix budget was used");
    expect(handoffBody()).toContain("FAIL src/a.test.ts");
  });

  it("is spent by the first failure, whatever kind the second one is", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "verify" });
    expect(runner.stages()).toEqual(["implement", "fix", "verify"]);
    expect(handoffBody()).toContain("after the fix budget was used");
    expect(handoffBody()).toContain("1 of 1 criteria unmet");
  });

  it("is spent by an unmet criterion that a red CI then follows", async () => {
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));
    tracker.ci = { state: "failed", summary: "checks/build failed" };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "ci" });
    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify"]);
    expect(handoffBody()).toContain("after the fix budget was used");
  });

  it("hands the Ticket off at fix when the fix Stage itself fails", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
    runner.queue("fix", { ok: false, failure: "turn-capped" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "fix" });
    expect(handoffBody()).toContain("the fix Stage hit its 150 turn limit");
    expect(handoffBody()).toContain("after the fix budget was used");
  });

  it("says nothing about the budget on a Ticket that never spent it", async () => {
    workspace.rebase = { ok: false, conflict: "CONFLICT (content): src/cli.ts" };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "rebase" });
    expect(handoffBody()).not.toMatch(/fix budget/i);
  });
});

describe("failures no fix Stage is offered", () => {
  /** Handed off where it stood, with the budget still unspent. */
  async function expectNoFix(stage: string): Promise<void> {
    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage });
    expect(runner.stages()).not.toContain("fix");
    expect(handoffBody()).not.toMatch(/fix budget/i);
  }

  it("refuses to retry an implement Stage that failed", async () => {
    runner.queue("implement", { ok: false, failure: "nonzero-exit" });

    await expectNoFix("implement");
  });

  it("refuses to retry a verify Stage that returned no usable Verdict", async () => {
    runner.queue("verify", { result: { nonsense: true } });

    await expectNoFix("verify");
  });

  it("refuses to retry a verify Stage that never returned", async () => {
    runner.queue("verify", { ok: false, failure: "timed-out" });

    await expectNoFix("verify");
  });

  it("refuses to retry a Verdict of nothing but unverifiable criteria", async () => {
    runner.queue("verify", {
      result: verdictResult([{ text: "it reads well", status: "unverifiable", evidence: "taste" }]),
    });

    await expectNoFix("verify");
  });

  it("refuses to retry a rebase conflict", async () => {
    workspace.rebase = { ok: false, conflict: "CONFLICT (content): src/cli.ts" };

    await expectNoFix("rebase");
  });

  it("refuses to retry a branch that could not be pushed", async () => {
    workspace.push = async () => {
      throw new Error("remote rejected");
    };

    await expectNoFix("pr");
  });

  it("refuses to retry CI that never finished", async () => {
    tracker.ci = { state: "timed-out" };

    await expectNoFix("ci");
  });

  it("refuses to retry a pull request that has no checks at all", async () => {
    tracker.ci = { state: "none" };

    await expectNoFix("ci");
  });
});

describe("the Planning guards", () => {
  /** What the pipeline said to the Ticket, if anything. */
  const warnings = () => tracker.comments.filter((c) => c.issue === TICKET).map((c) => c.body);

  /** Nothing was claimed and no Stage was started. */
  function expectUntouched() {
    expect(tracker.calls).not.toContain(`assign:${TICKET}:pipeline-user`);
    expect(tracker.issue(TICKET).labels).not.toContain("in-progress");
    expect(runner.requests).toEqual([]);
    expect(workspace.worktrees.size).toBe(0);
  }

  it("skips a candidate with native sub-issues and says it is a Spec", async () => {
    tracker.issue(TICKET).subIssues = 4;

    const outcome = await run();

    expect(outcome).toEqual({
      outcome: "skipped",
      ticket: TICKET,
      title: "Skeleton: one Ticket end to end",
      reason: "spec",
    });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("<!-- agent-pipeline:guard:spec -->");
    expect(warnings()[0]).toContain("it is a Spec, not a Ticket");
    expectUntouched();
  });

  it("takes ready-for-agent off the Spec, so no Run offers it again", async () => {
    tracker.issue(TICKET).subIssues = 4;

    await run();

    expect(tracker.issue(TICKET).labels).toEqual([]);
    expect(tracker.calls).toContain(`removeLabel:${TICKET}:ready-for-agent`);
  });

  it("skips a candidate with no acceptance criteria anywhere", async () => {
    tracker.issue(TICKET).body = "## What to build\n\nSomething good.";

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "skipped", reason: "no-criteria" });
    expect(warnings()[0]).toContain("<!-- agent-pipeline:guard:no-criteria -->");
    expectUntouched();
  });

  it("leaves a criteria-less Ticket labelled, because a human can still fix it", async () => {
    tracker.issue(TICKET).body = "## What to build\n\nSomething good.";

    await run();

    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-agent"]);
  });

  it("takes the criteria a triage comment posted instead of the body", async () => {
    const issue = tracker.issue(TICKET);
    issue.body = "## What to build\n\nSomething good.";
    issue.comments = ["Brief:\n\n- [ ] it works"];

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
  });

  it("skips a candidate whose body names blockers GitHub does not know about", async () => {
    tracker.issue(TICKET).body = "- [ ] it works\n\n## Blocked by\n\n- #3\n";

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "skipped", reason: "body-only-blockers" });
    expect(warnings()[0]).toContain("<!-- agent-pipeline:guard:body-only-blockers -->");
    expectUntouched();
  });

  it("takes a Ticket whose body copy matches its native edges", async () => {
    const issue = tracker.issue(TICKET);
    issue.body = "- [ ] it works\n\n## Blocked by\n\n- #3\n";
    issue.blockedBy = [3];

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
  });

  it("warns once, however many Runs meet the same candidate", async () => {
    tracker.issue(TICKET).body = "## What to build\n\nSomething good.";

    await run();
    // The first warning is on the issue now, which is what the second Run reads.
    await run();

    expect(warnings()).toHaveLength(1);
    expect(tracker.issue(TICKET).comments).toHaveLength(1);
  });

  it("warns again when a second guard has something else to say", async () => {
    const issue = tracker.issue(TICKET);
    issue.body = "## What to build\n\nSomething good.";
    issue.comments = ["<!-- agent-pipeline:guard:body-only-blockers -->\n**Skipped by agent-pipeline.**"];

    await run();

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("no-criteria");
  });
});

describe("an issue that is nobody\u0027s to take", () => {
  it("refuses one somebody has already claimed, without a word on the issue", async () => {
    tracker.issue(TICKET).assignees = ["octocat"];

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "skipped", reason: "claimed" });
    expect(tracker.comments).toEqual([]);
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-agent"]);
  });

  it("refuses one that is not labelled ready-for-agent", async () => {
    tracker.issue(TICKET).labels = ["needs-triage"];

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "skipped", reason: "not-ready" });
    expect(tracker.comments).toEqual([]);
    expect(runner.requests).toEqual([]);
  });

  it("refuses a Spec nobody labelled, rather than commenting on it", async () => {
    const issue = tracker.issue(TICKET);
    issue.labels = [];
    issue.subIssues = 9;

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "skipped", reason: "not-ready" });
    expect(tracker.comments).toEqual([]);
  });

  it("refuses under the label this repo configured", async () => {
    tracker.issue(TICKET).labels = ["ready-for-agent"];

    const outcome = await run({
      labels: { ...config().labels, readyForAgent: "agent-ready" },
    });

    expect(outcome).toMatchObject({ outcome: "skipped", reason: "not-ready" });
  });
});

function handoffBody(): string {
  const comment = tracker.comments.at(-1);
  if (!comment) throw new Error("no hand-off comment was written");
  return comment.body;
}
