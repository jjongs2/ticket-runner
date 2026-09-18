import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UNCHECKED_BOX } from "./acceptance-criteria.js";
import type { Config } from "./config.js";
import { processTicket } from "./orchestrator.js";
import {
  type TicketState,
  readTicketState,
  statePath,
  writeTicketState,
} from "./resume.js";
import { PROGRESS_MARKER } from "./progress.js";
import type { TicketOutcome } from "./orchestrator.js";
import type { StageName } from "./ports/agent-runner.js";
import { FakeAgentRunner, FakeTracker, FakeWorkspace, stageResult } from "./testing/fakes.js";

const TICKET = 2;
const BRANCH = "agent/2-skeleton-one-ticket-end-to-end";
const URL = "https://github.com/acme/repo/issues/2";
const CONFLICT = "CONFLICT (content): Merge conflict in src/cli.ts";
const UNRESOLVED = { resolved: false, unresolved: "a rebase is still in progress" } as const;

function config(overrides: Partial<Config> = {}): Config {
  return {
    checks: ["npm test", "npm run typecheck"],
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

/**
 * The comments a human is notified about. The progress comment is not one of
 * them after its first Stage, which is the whole point of editing it in place.
 */
const notices = () => tracker.comments.filter(({ body }) => !body.startsWith(PROGRESS_MARKER));

let tracker: FakeTracker;
let runner: FakeAgentRunner;
let workspace: FakeWorkspace;
/**
 * A temporary repo root, because a claimed Ticket's State file is a real file
 * (ADR-0004). The three ports are still fakes; only the local state is not.
 */
let repoRoot: string;
/** Where this Ticket's Stages run, under the repo root the Run was given. */
let worktree: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "agent-pipeline-ticket-"));
  worktree = join(repoRoot, ".worktrees", `ticket-${TICKET}`);
  tracker = new FakeTracker();
  tracker.addIssue({ number: TICKET, title: "Skeleton: one Ticket end to end", url: URL });
  runner = new FakeAgentRunner({
    verify: stageResult({ result: PASSING_VERDICT }),
  });
  workspace = new FakeWorkspace();
  // A fix session commits, as the real one does when it mends anything: what it
  // left on the branch is part of how the Stage is judged, so the fake says so.
  runner.leaves("fix", () => workspace.commits.push("fix(cli): mend the thing (#2)"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

/**
 * The State file as it stood when each Stage started.
 *
 * The file is written as part of the Claim and rewritten as the Ticket advances,
 * and by the time a Run comes back it has been cleared — so the only place those
 * writes can be read is from inside the Run.
 */
function stateAtEachStage(): { stage: StageName; state: TicketState | undefined }[] {
  const seen: { stage: StageName; state: TicketState | undefined }[] = [];
  const runStage = runner.run.bind(runner);
  runner.run = async (request) => {
    seen.push({ stage: request.stage, state: readTicketState(repoRoot, TICKET) });
    return runStage(request);
  };
  return seen;
}

function run(overrides: Partial<Config> = {}): Promise<TicketOutcome> {
  return processTicket(
    {
      tracker,
      runner,
      workspace,
      config: config(overrides),
      repoRoot,
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
      notes: [],
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
    // Asking whether the branch is there is not a side effect; creating the
    // worktree is the first one the workspace sees.
    expect(workspace.calls.filter((call) => call !== `hasBranch:${BRANCH}`)[0]).toBe(
      `createWorktree:${BRANCH}`,
    );
  });

  it("implements in a worktree on a fresh branch named after the Ticket", async () => {
    await run();

    expect(workspace.calls.slice(0, 2)).toEqual([
      `hasBranch:${BRANCH}`,
      `createWorktree:${BRANCH}`,
    ]);
    expect(runner.requests[0]?.cwd).toBe(worktree);
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
    expect(notices()).toEqual([]);
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
      expect(request.logDir).toBe(`${repoRoot}/.agent-pipeline/runs/run-1/${TICKET}`);
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

  it("makes the verify Stage's structured output the one it cannot do without", async () => {
    await run();

    // implement is asked for a schema too, but only to carry Notes: a session
    // that emitted none has still implemented the Ticket.
    expect(runner.requests[0]?.jsonSchema).toBeDefined();
    expect(runner.requests[0]?.resultRequired).toBe(false);
    expect(runner.requests[1]?.jsonSchema).toBeDefined();
    expect(runner.requests[1]?.resultRequired).toBeUndefined();
  });
});

describe("implement Stage failures", () => {
  it("hands off when the Stage itself fails", async () => {
    runner.queue("implement", { ok: false, failure: "nonzero-exit" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "implement" });
    expect(runner.stages()).toEqual(["implement"]);
  });

  it("releases the Ticket rather than blaming it for a rate limit", async () => {
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    expect(await run()).toMatchObject({ outcome: "released" });
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
      { command: "npm test", cwd: worktree },
      { command: "npm run typecheck", cwd: worktree },
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

    expect(workspace.calls).toContain(`discardChanges:${worktree}`);
  });

  it("discards scratch files even when the Stage failed", async () => {
    runner.queue("verify", { ok: false, failure: "timed-out" });

    await run();

    expect(workspace.calls).toContain(`discardChanges:${worktree}`);
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

  it("sends no conflict Stage in when the branch rebases cleanly", async () => {
    await run();

    expect(runner.stages()).toEqual(["implement", "verify"]);
    expect(workspace.calls).not.toContain("rebaseState");
    expect(workspace.aborts).toBe(0);
  });

  it("sends one conflict Stage into the stopped rebase", async () => {
    workspace.conflictOnce(CONFLICT);

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["implement", "verify", "conflict"]);
  });

  it("drives the skill, from the worktree, under the conflict Stage's own limits", async () => {
    workspace.conflictOnce(CONFLICT);

    await run();

    const request = runner.requests.find((r) => r.stage === "conflict");
    expect(request).toMatchObject({ cwd: worktree, maxTurns: 120, maxMinutes: 30 });
    expect(request?.prompt).toContain("/mattpocock-skills:resolving-merge-conflicts");
    expect(request?.prompt).toContain(URL);
    expect(request?.prompt).toContain(CONFLICT);
  });

  it("runs the Checks again on the resolution before the PR", async () => {
    workspace.conflictOnce(CONFLICT);

    await run();

    expect(workspace.ranChecks.map((check) => check.command)).toEqual([
      "npm test",
      "npm run typecheck",
      "npm test",
      "npm run typecheck",
    ]);
    expect(workspace.calls.lastIndexOf("runCheck:npm run typecheck")).toBeLessThan(
      workspace.calls.indexOf(`push:${BRANCH}`),
    );
  });

  it("takes a Stage that finished the rebase and only then ran out of turns", async () => {
    workspace.conflictOnce(CONFLICT);
    runner.queue("conflict", { ok: false, failure: "turn-capped" });

    expect(await run()).toMatchObject({ outcome: "merged" });
  });

  it("spends the fix budget when the conflict outlives the Stage", async () => {
    workspace.rebase = { ok: false, conflict: CONFLICT };
    workspace.rebaseStateAfterStage = UNRESOLVED;

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "rebase" });
    expect(runner.stages()).toEqual([
      "implement",
      "verify",
      "conflict",
      "fix",
      "verify",
      "conflict",
    ]);
    expect(handoffBody()).toContain("after the fix budget was used");
    expect(handoffBody()).toContain(CONFLICT);
    expect(handoffBody()).toContain("a rebase is still in progress");
  });

  it("aborts the rebase it could not finish, so the worktree can be worked in", async () => {
    workspace.conflictOnce(CONFLICT);
    workspace.rebaseStateAfterStage = UNRESOLVED;

    await run();

    // The fix Stage runs between the abort and the pass it bought, so a
    // Check running again after the abort is a worktree it could commit in.
    expect(runner.stages()).toContain("fix");
    expect(workspace.calls.indexOf("abortRebase")).toBeLessThan(
      workspace.calls.lastIndexOf("runCheck:npm test"),
    );
    expect(workspace.aborts).toBe(1);
  });

  it("aborts the rebase even when the Stage itself could not be started", async () => {
    workspace.conflictOnce(CONFLICT);
    const run_ = runner.run.bind(runner);
    runner.run = async (request) => {
      if (request.stage === "conflict") throw new Error("claude: command not found");
      return run_(request);
    };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "rebase" });
    expect(workspace.aborts).toBe(1);
    // Nothing a fix Stage could mend, so the budget is still there.
    expect(handoffBody()).not.toMatch(/fix budget/i);
  });

  it("hands off naming the limit when the conflict Stage ran out of turns", async () => {
    // A Check spends the budget first, so this conflict gets one Stage only.
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
    workspace.rebase = { ok: false, conflict: CONFLICT };
    workspace.rebaseStateAfterStage = UNRESOLVED;
    runner.queue("conflict", { ok: false, failure: "turn-capped" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "rebase" });
    expect(handoffBody()).toContain("the conflict Stage hit its 120 turn limit");
  });

  it("does not spend the fix budget on a conflict it resolved", async () => {
    workspace.conflictOnce(CONFLICT);
    tracker.queueCi({ state: "failed", summary: "checks/build failed", excerpt: "" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["implement", "verify", "conflict", "fix", "verify"]);
  });
});

describe("CI", () => {
  it("waits for the PR checks up to the configured timeout", async () => {
    await run({ ciTimeoutMinutes: 5 });

    expect(tracker.ciWaits).toEqual([{ pullRequest: 100, timeoutMs: 5 * 60_000 }]);
  });

  it("hands off when a check fails", async () => {
    tracker.ci = { state: "failed", summary: "checks/build failed", excerpt: "" };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "ci" });
    expect(handoffBody()).toContain("checks/build failed");
  });

  it("shows the CI log excerpt as the hand-off evidence", async () => {
    tracker.ci = {
      state: "failed",
      summary: "checks/build failed",
      excerpt: "build\nerror TS2345: not assignable",
    };

    await run();

    expect(handoffBody()).toContain("<details><summary>Evidence</summary>");
    expect(handoffBody()).toContain("error TS2345: not assignable");
  });

  it("drops the evidence block when no CI log could be fetched", async () => {
    tracker.ci = { state: "failed", summary: "checks/build failed", excerpt: "" };

    await run();

    expect(handoffBody()).toContain("checks/build failed");
    expect(handoffBody()).not.toContain("<details><summary>Evidence</summary>");
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
    tracker.ci = { state: "failed", summary: "checks/build failed", excerpt: "" };

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
    // The worktree the Stage would have run in was never created.
    expect(handoffBody()).not.toContain(`worktree \`${worktree}\``);
    expect(workspace.calls).not.toContain(`push:${BRANCH}`);
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
    expect(notices()).toEqual([]);
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
    expect(handoffBody()).toContain(`worktree \`${worktree}\``);
    expect(handoffBody()).toContain("PR #100 (draft)");
  });

  it("keeps the worktree and the branch for a human to pick up", async () => {
    await run();

    expect(workspace.worktrees.get(worktree)).toBe(BRANCH);
    expect(workspace.calls).not.toContain(`removeWorktree:${BRANCH}`);
  });

  it("converts the existing PR to a draft rather than opening a second one", async () => {
    workspace.commits = ["feat(cli): do the thing (#2)"];
    tracker.ci = { state: "failed", summary: "checks/build failed", excerpt: "" };

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

  it("swallows a push out of a worktree that is no longer there", async () => {
    // What the fake does to an unknown path is what git does: a working
    // directory that is not on disk is an ENOENT, not a push that quietly
    // works. Here a human removed the worktree while the Stage was running.
    runner.leaves("implement", () => workspace.worktrees.delete(worktree));

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off" });
    // Attempted, because the Ticket did have a worktree, and then refused.
    expect(workspace.calls).toContain(`push:${BRANCH}`);
    expect(workspace.pushes).toEqual([]);
    expect(tracker.pullRequests).toEqual([]);
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
    expect(fixRequest().cwd).toBe(worktree);
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
    tracker.queueCi({ state: "failed", summary: "checks/build failed", excerpt: "" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged", pullRequest: 100 });
    expect(tracker.pullRequests).toHaveLength(1);
    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify"]);
    expect(runner.prompts("fix")[0]).toMatch(/pull request check failed/i);
    expect(runner.prompts("fix")[0]).toContain("checks/build failed");
  });

  it("hands the fix Stage the CI log, not just the check names", async () => {
    tracker.queueCi({
      state: "failed",
      summary: "checks/build failed",
      excerpt: "build\nerror TS2345: not assignable",
    });

    await run();

    expect(runner.prompts("fix")[0]).toContain("checks/build failed");
    expect(runner.prompts("fix")[0]).toContain("```\nbuild\nerror TS2345: not assignable\n```");
  });

  it("pushes the fixed branch and waits for CI a second time", async () => {
    tracker.queueCi({ state: "failed", summary: "checks/build failed", excerpt: "" });

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

  it("asks the fix Stage for structured output it may leave empty", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");

    await run();

    expect(fixRequest().jsonSchema).toBeDefined();
    expect(fixRequest().resultRequired).toBe(false);
  });

  it("logs the second pass beside the first rather than over it", async () => {
    const ticketLogs = `${repoRoot}/.agent-pipeline/runs/run-1/${TICKET}`;
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));

    await run();

    // The Stage's files are named after the Stage, so the failing Verdict's
    // transcript would otherwise be overwritten by the one that passed.
    expect(runner.requests.map((request) => [request.stage, request.logDir])).toEqual([
      ["implement", ticketLogs],
      ["verify", ticketLogs],
      ["fix", `${ticketLogs}/retry`],
      ["verify", `${ticketLogs}/retry`],
    ]);
  });

  it("rewrites the pull request body with the Verdict the second pass reached", async () => {
    tracker.queueCi({ state: "failed", summary: "checks/build failed", excerpt: "" });
    runner.queue("verify", stageResult({ result: MIXED_VERDICT }));
    runner.queue("verify", stageResult({ result: PASSING_VERDICT }));

    await run();

    // The merge carries the second Verdict, so the PR a human reads must too.
    expect(tracker.calls).toContain("updatePullRequestBody:100");
    expect(tracker.pullRequest(100).body).toContain(
      "**Verdict:** 1 met · 0 unmet · 0 unverifiable",
    );
  });

  it("leaves the pull request body alone when there was no second pass", async () => {
    await run();

    expect(tracker.calls).not.toContain("updatePullRequestBody:100");
  });
});

describe("a fix Stage that committed nothing", () => {
  /** The session came back clean: it ran, and the branch is as it found it. */
  beforeEach(() => {
    runner.leaves("fix", () => {});
  });

  it("hands the Ticket off at fix, saying the branch never grew", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "fix" });
    expect(handoffBody()).toContain("the fix Stage left no new commits on the branch");
    expect(handoffBody()).toContain("after the fix budget was used");
    expect(progressTable()).toContain("| fix | ❌ no commits | 7 | 0m |");
  });

  it("stops the pass there, so nothing re-grades a branch nobody touched", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");

    await run();

    // The Check that bought the fix Stage ran once, not twice, and neither the
    // Verdict nor CI was asked about a branch the fix Stage left alone.
    expect(workspace.ranChecks.map((check) => check.command)).toEqual(["npm test"]);
    expect(runner.stages()).toEqual(["implement", "fix"]);
    expect(tracker.ciWaits).toEqual([]);
  });

  it.each([
    [
      "a failed Check",
      () => {
        workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
      },
    ],
    [
      "unmet Acceptance Criteria",
      () => {
        runner.queue("verify", stageResult({ result: UNMET_VERDICT }));
      },
    ],
    [
      "a red CI",
      () => {
        tracker.queueCi({ state: "failed", summary: "checks/build failed", excerpt: "" });
      },
    ],
  ])("reads the same whichever failure bought the Stage: %s", async (_kind, arrange) => {
    arrange();

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "fix" });
    expect(handoffBody()).toContain("the fix Stage left no new commits on the branch");
    expect(progressTable()).toContain("| fix | ❌ no commits |");
  });

  it("routes the Notes it made before its own outcome is judged", async () => {
    const other = 7;
    tracker.addIssue({ number: other, title: "Progress comment" });
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
    runner.queue(
      "fix",
      stageResult({ result: { notes: [{ ticket: other, note: "found while fixing" }] } }),
    );

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "handed-off",
      stage: "fix",
      notes: [{ origin: TICKET, stage: "fix", issue: other, note: "found while fixing" }],
    });
  });

  it("is still released, not blamed, when the rate limit is why it committed nothing", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
    runner.queue("fix", { ok: false, failure: "rate-limited" });

    const outcome = await run();

    // The limit is read before the branch is: a Ticket released here spends no
    // budget, and the Run that resumes it still has the fix Stage to buy.
    expect(outcome).toMatchObject({ outcome: "released", stage: "fix" });
    expect(progressTable()).toContain("| fix | ⏸ rate limited |");
  });

  it("leaves a Stage that did commit reported as committed", async () => {
    runner.leaves("fix", () => workspace.commits.push("fix(cli): mend the thing (#2)"));
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(progressTable()).toContain("| fix | ✅ committed | 7 | 0m |");
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
    tracker.ci = { state: "failed", summary: "checks/build failed", excerpt: "" };

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
    runner.queue("verify", { ok: false, failure: "timed-out" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "verify" });
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

describe("releasing a rate-limited Ticket", () => {
  /** The State file the release left, as a later Run would read it. */
  const state = () => readTicketState(repoRoot, TICKET);

  it("releases the Ticket rather than handing it to a human", async () => {
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    const outcome = await run();

    expect(outcome).toEqual({
      outcome: "released",
      ticket: TICKET,
      title: "Skeleton: one Ticket end to end",
      branch: BRANCH,
      stage: "implement",
      notes: [],
    });
  });

  it("undoes the Claim, so the next Run may pick the Ticket up", async () => {
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    await run();

    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-agent"]);
    expect(tracker.issue(TICKET).assignees).toEqual([]);
  });

  it("takes the assignee off last, so no other Run sees an unclaimed Ticket first", async () => {
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    await run();

    expect(tracker.calls.slice(-3)).toEqual([
      `addLabel:${TICKET}:ready-for-agent`,
      `removeLabel:${TICKET}:in-progress`,
      `unassign:${TICKET}:pipeline-user`,
    ]);
  });

  it("keeps the branch and the worktree for the Run that resumes them", async () => {
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    await run();

    expect(workspace.worktrees.get(worktree)).toBe(BRANCH);
    expect(workspace.calls).not.toContain(`removeWorktree:${BRANCH}`);
    expect(workspace.calls).not.toContain(`deleteRemoteBranch:${BRANCH}`);
  });

  it("notifies nobody and merges nothing", async () => {
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    await run();

    expect(notices()).toEqual([]);
    expect(tracker.pullRequests).toEqual([]);
  });

  it("records the state reached, the branch and the unspent fix budget", async () => {
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    await run();

    expect(state()).toMatchObject({
      ticket: TICKET,
      branch: BRANCH,
      state: "claimed",
      fixUsed: false,
      runId: "run-1",
    });
  });

  it("reads as a pause in the progress table, not a failure", async () => {
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    await run();

    expect(progressTable()).toContain("| implement | ⏸ rate limited | 7 | 0m |");
  });

  it("records the implement Stage's work when the verify Stage is stopped", async () => {
    runner.queue("verify", { ok: false, failure: "rate-limited" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "released", stage: "verify" });
    expect(state()).toMatchObject({ state: "implemented", fixUsed: false });
    expect(progressTable()).toContain("| verify | ⏸ rate limited |");
  });

  it("gives back the fix budget a stopped fix Stage never spent", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
    runner.queue("fix", { ok: false, failure: "rate-limited" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "released", stage: "fix" });
    expect(state()).toMatchObject({ state: "implemented", fixUsed: false });
  });

  it("records a fix budget an earlier pass of this Run did spend", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
    runner.queue("verify", { ok: false, failure: "rate-limited" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "released", stage: "verify" });
    expect(runner.stages()).toEqual(["implement", "fix", "verify"]);
    expect(state()).toMatchObject({ state: "implemented", fixUsed: true });
  });

  it("records the pull request the Run had already opened", async () => {
    tracker.queueCi({ state: "failed", summary: "checks/build failed", excerpt: "" });
    runner.queue("verify", stageResult({ result: PASSING_VERDICT }));
    runner.queue("verify", { ok: false, failure: "rate-limited" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "released" });
    expect(state()).toMatchObject({ pullRequest: 100, fixUsed: true });
    expect(tracker.pullRequest(100).draft).toBe(false);
  });

  it("aborts the rebase a stopped conflict Stage left behind", async () => {
    workspace.rebase = { ok: false, conflict: CONFLICT };
    workspace.rebaseStateAfterStage = UNRESOLVED;
    runner.queue("conflict", { ok: false, failure: "rate-limited" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "released", stage: "rebase" });
    // No fix Stage: a rate limit spends nothing, and the conflict is still
    // there for the Run that resumes the Ticket to rebase into.
    expect(runner.stages()).toEqual(["implement", "verify", "conflict"]);
    expect(workspace.aborts).toBe(1);
    expect(state()).toMatchObject({ state: "implemented", fixUsed: false });
    expect(progressTable()).toContain("| conflict | ⏸ rate limited |");
  });

  it("takes a conflict Stage that finished the rebase before the limit came", async () => {
    workspace.conflictOnce(CONFLICT);
    runner.queue("conflict", { ok: false, failure: "rate-limited" });

    // The worktree decides the conflict Stage, as it decides the turn-capped
    // one: nothing after the rebase needs an agent, so the Ticket can merge.
    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(state()).toBeUndefined();
    expect(progressTable()).toContain("| conflict | ✅ rebased |");
  });

  it("leaves no State file behind when the Ticket is handed off instead", async () => {
    runner.queue("implement", { ok: false, failure: "turn-capped" });

    expect(await run()).toMatchObject({ outcome: "handed-off" });
    expect(state()).toBeUndefined();
  });

  it("leaves no State file behind when the Ticket merges", async () => {
    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(state()).toBeUndefined();
  });
});

describe("the State file a claimed Ticket keeps", () => {
  it("is written as part of the Claim, before any Stage runs", async () => {
    const seen = stateAtEachStage();

    await run();

    expect(seen[0]).toEqual({
      stage: "implement",
      state: {
        ticket: TICKET,
        branch: BRANCH,
        state: "claimed",
        fixUsed: false,
        runId: "run-1",
        updatedAt: expect.any(String),
      },
    });
  });

  it("is on disk before the Claim reaches the board", async () => {
    let atClaim: TicketState | undefined;
    const assign = tracker.assign.bind(tracker);
    tracker.assign = async (number, assignee) => {
      atClaim = readTicketState(repoRoot, TICKET);
      return assign(number, assignee);
    };

    await run();

    // A Claim no State file names is what the order rules out: a crash between
    // the two writes leaves a Ticket nobody claimed, which resumes itself.
    expect(atClaim).toMatchObject({ state: "claimed", branch: BRANCH });
  });

  it("says implemented once the implement Stage has come back with commits", async () => {
    const seen = stateAtEachStage();

    await run();

    expect(seen.map(({ stage, state }) => [stage, state?.state])).toEqual([
      ["implement", "claimed"],
      ["verify", "implemented"],
    ]);
  });

  it("is not moved on until the implement Stage's commits have been counted", async () => {
    let atCount: TicketState | undefined;
    const commitSubjects = workspace.commitSubjects.bind(workspace);
    workspace.commitSubjects = async (branch) => {
      atCount ??= readTicketState(repoRoot, TICKET);
      return commitSubjects(branch);
    };

    await run();

    // The first read is the implement Stage's own "did it commit anything", and
    // the state is still claimed there: a Stage that left a clean branch never
    // reaches implemented.
    expect(atCount).toMatchObject({ state: "claimed" });
  });

  it("stays at claimed when the implement Stage left nothing on the branch", async () => {
    workspace.commits = [];
    const seen = stateAtEachStage();

    // The Ticket is handed off, so the only reading left is the fix Stage's —
    // and there is none, because a branch with no commits buys no fix Stage.
    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "implement" });
    expect(seen.map(({ state }) => state?.state)).toEqual(["claimed"]);
  });

  it("fails the Ticket at setup rather than claiming what it cannot record", async () => {
    // A file where the state directory has to go, so the very first write fails.
    mkdirSync(join(repoRoot, ".agent-pipeline"), { recursive: true });
    writeFileSync(join(repoRoot, ".agent-pipeline", "state"), "not a directory");

    await expect(run()).rejects.toThrow();

    // Nothing was claimed, so there is no Claim for a later Run to be stuck on.
    expect(tracker.issue(TICKET).assignees).toEqual([]);
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-agent"]);
    expect(runner.requests).toEqual([]);
  });

  it("names the pull request once it is open", async () => {
    let atCi: TicketState | undefined;
    const waitForCi = tracker.waitForCi.bind(tracker);
    tracker.waitForCi = async (number, timeoutMs) => {
      atCi = readTicketState(repoRoot, TICKET);
      return waitForCi(number, timeoutMs);
    };

    await run();

    expect(atCi).toMatchObject({ state: "implemented", pullRequest: 100 });
  });

  it("records the fix budget once the fix Stage has come back, not before it runs", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
    const seen = stateAtEachStage();

    expect(await run()).toMatchObject({ outcome: "merged" });

    expect(seen.map(({ stage, state }) => [stage, state?.fixUsed])).toEqual([
      ["implement", false],
      // The budget is committed before the Stage starts and recorded only once it
      // is back, so a fix Stage the rate limit stops still leaves it unspent.
      ["fix", false],
      ["verify", true],
    ]);
  });

  it("is gone once the Ticket merges", async () => {
    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(existsSync(statePath(repoRoot, TICKET))).toBe(false);
  });

  it("is gone once the Ticket is handed off", async () => {
    workspace.failCheck("npm test", "FAIL src/a.test.ts");

    expect(await run()).toMatchObject({ outcome: "handed-off" });
    expect(existsSync(statePath(repoRoot, TICKET))).toBe(false);
  });

  it("is never written for a candidate a guard passed over", async () => {
    tracker.issue(TICKET).subIssues = 3;

    expect(await run()).toMatchObject({ outcome: "skipped", reason: "spec" });
    expect(existsSync(statePath(repoRoot, TICKET))).toBe(false);
  });
});

/**
 * A **Stranded Ticket**: one a Run claimed and never released, because the Run
 * was killed. The Claim is still on the board and the State file is still beside
 * the worktree, which together is what says so (CONTEXT.md).
 */
describe("resuming a stranded Ticket", () => {
  /** Exactly what a killed Run leaves: the Claim, the worktree, the State file. */
  function strandedTicket(overrides: Partial<TicketState> = {}): void {
    const state: TicketState = {
      ticket: TICKET,
      branch: BRANCH,
      state: "implemented",
      fixUsed: false,
      runId: "run-0",
      updatedAt: "2026-09-17T09:00:00.000Z",
      ...overrides,
    };
    const issue = tracker.issue(TICKET);
    issue.assignees = ["pipeline-user"];
    issue.labels = ["in-progress"];
    workspace.worktrees.set(worktree, state.branch);
    workspace.branches.add(state.branch);
    writeTicketState(repoRoot, state);
  }

  it("is resumed rather than refused as claimed", async () => {
    strandedTicket();

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["verify"]);
    expect(workspace.calls).not.toContain(`createWorktree:${BRANCH}`);
  });

  it("keeps the Claim it already has, re-assigning and relabelling nothing", async () => {
    strandedTicket();

    await run();

    expect(tracker.calls).not.toContain(`assign:${TICKET}:pipeline-user`);
    expect(tracker.calls).not.toContain(`addLabel:${TICKET}:in-progress`);
    expect(tracker.calls).not.toContain(`removeLabel:${TICKET}:ready-for-agent`);
  });

  it("runs the implement Stage again when that is the state recorded", async () => {
    strandedTicket({ state: "claimed" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["implement", "verify"]);
    expect(runner.requests[0]?.cwd).toBe(worktree);
  });

  it("is handed off at its next failure when the recorded fix budget is spent", async () => {
    strandedTicket({ fixUsed: true });
    workspace.failCheck("npm test", "FAIL src/a.test.ts");

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "checks" });
    expect(runner.stages()).toEqual([]);
    expect(existsSync(statePath(repoRoot, TICKET))).toBe(false);
  });

  it("aborts a rebase the killed Run left in the worktree before the Checks run", async () => {
    strandedTicket();

    await run();

    expect(workspace.aborts).toBe(1);
    expect(workspace.calls.indexOf("abortRebase")).toBeLessThan(
      workspace.calls.indexOf("runCheck:npm test"),
    );
  });

  it("is taken from the top, in place, when its worktree and branch are gone", async () => {
    strandedTicket();
    workspace.worktrees.delete(worktree);
    workspace.branches.delete(BRANCH);

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(workspace.calls).toContain(`createWorktree:${BRANCH}`);
    expect(runner.stages()).toEqual(["implement", "verify"]);
    // Nothing was re-assigned or relabelled: the Claim was already this Run's.
    expect(tracker.calls).not.toContain(`assign:${TICKET}:pipeline-user`);
  });

  it("is handed off at setup when its branch outlived its worktree", async () => {
    strandedTicket();
    workspace.worktrees.delete(worktree);

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "setup" });
    expect(handoffBody()).toContain(`git branch -D ${BRANCH}`);
    expect(workspace.calls).not.toContain(`createWorktree:${BRANCH}`);
  });

  it("is refused as claimed when there is no State file beside it", async () => {
    const issue = tracker.issue(TICKET);
    issue.assignees = ["pipeline-user"];
    issue.labels = ["in-progress"];

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "skipped", reason: "claimed" });
    expect(runner.requests).toEqual([]);
    expect(tracker.comments).toEqual([]);
  });

  it("is refused when the Claim on it is somebody else's, State file or not", async () => {
    strandedTicket();
    tracker.issue(TICKET).assignees = ["octocat"];

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "skipped", reason: "claimed" });
    expect(existsSync(statePath(repoRoot, TICKET))).toBe(true);
  });

  it("is released again, with its state current, when the rate limit is still on", async () => {
    strandedTicket();
    runner.queue("verify", { ok: false, failure: "rate-limited" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "released", stage: "verify" });
    expect(readTicketState(repoRoot, TICKET)).toMatchObject({
      state: "implemented",
      runId: "run-1",
    });
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-agent"]);
    expect(tracker.issue(TICKET).assignees).toEqual([]);
  });
});

describe("resuming a released Ticket", () => {
  /** Leave behind exactly what a release leaves: a worktree, a branch, a State file. */
  function released(overrides: Partial<TicketState> = {}): void {
    const state: TicketState = {
      ticket: TICKET,
      branch: BRANCH,
      state: "implemented",
      fixUsed: false,
      runId: "run-0",
      updatedAt: "2026-09-17T09:00:00.000Z",
      ...overrides,
    };
    workspace.worktrees.set(worktree, state.branch);
    workspace.branches.add(state.branch);
    writeTicketState(repoRoot, state);
  }

  it("carries on at the Checks rather than implementing the Ticket again", async () => {
    released();

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["verify"]);
    expect(workspace.calls).not.toContain(`createWorktree:${BRANCH}`);
    // Nothing is branched, so nothing is in the way: the branch is not asked about.
    expect(workspace.calls).not.toContain(`hasBranch:${BRANCH}`);
    expect(workspace.ranChecks.map((check) => check.cwd)).toEqual([worktree, worktree]);
  });

  it("runs the implement Stage again when that is what the limit stopped", async () => {
    released({ state: "claimed" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["implement", "verify"]);
    expect(workspace.calls).not.toContain(`createWorktree:${BRANCH}`);
    expect(runner.requests[0]?.cwd).toBe(worktree);
  });

  it("works on the branch the State file names, whatever the Ticket is called now", async () => {
    released({ branch: "agent/2-what-the-Ticket-was-called-then" });

    await run();

    expect(tracker.pullRequest(100).head).toBe("agent/2-what-the-Ticket-was-called-then");
    expect(workspace.pushes.map((push) => push.branch)).toEqual([
      "agent/2-what-the-Ticket-was-called-then",
    ]);
  });

  it("claims the Ticket again before it does anything else", async () => {
    released();

    await run();

    expect(tracker.calls.slice(0, 3)).toEqual([
      `assign:${TICKET}:pipeline-user`,
      `addLabel:${TICKET}:in-progress`,
      `removeLabel:${TICKET}:ready-for-agent`,
    ]);
  });

  it("honours a fix budget an earlier Run had already spent", async () => {
    released({ fixUsed: true });
    workspace.failCheck("npm test", "FAIL src/a.test.ts");

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "checks" });
    expect(runner.stages()).toEqual([]);
    expect(handoffBody()).toContain("after the fix budget was used");
  });

  it("still buys a fix Stage when the budget came back unspent", async () => {
    released();
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["fix", "verify"]);
  });

  it("brings the pull request the earlier Run opened up to date", async () => {
    tracker.pullRequests.push({
      number: 100,
      head: BRANCH,
      title: "feat(cli): do the thing",
      body: `Closes #${TICKET}`,
      draft: false,
      merged: false,
    });
    released({ pullRequest: 100 });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged", pullRequest: 100 });
    expect(tracker.pullRequests).toHaveLength(1);
    expect(tracker.calls).toContain("updatePullRequestBody:100");
  });

  it("clears the State file once the resumed Ticket merges", async () => {
    released();

    await run();

    expect(existsSync(statePath(repoRoot, TICKET))).toBe(false);
  });

  it("clears the State file when the resumed Ticket is handed off", async () => {
    released({ fixUsed: true });
    workspace.failCheck("npm test", "FAIL src/a.test.ts");

    await run();

    expect(existsSync(statePath(repoRoot, TICKET))).toBe(false);
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-human"]);
  });

  it("starts the Ticket over when the worktree and the branch are both gone", async () => {
    // Nothing is seeded on the workspace: the human who removed the worktree
    // removed the branch with it, so there is nothing in the way of a fresh one.
    writeTicketState(repoRoot, {
      ticket: TICKET,
      branch: BRANCH,
      state: "implemented",
      fixUsed: true,
      runId: "run-0",
      updatedAt: "2026-09-17T09:00:00.000Z",
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(workspace.calls).toContain(`createWorktree:${BRANCH}`);
    expect(runner.stages()).toEqual(["implement", "verify"]);
    // And the State file nothing can resume from is gone, so the next Run is
    // not asked the same question again.
    expect(existsSync(statePath(repoRoot, TICKET))).toBe(false);
  });
});

/**
 * A branch left behind by work nobody can account for: a human who finished a
 * handed-off Ticket and deleted the worktree without the branch, or a Ticket
 * taken from the top after its worktree went. Creating the worktree would fail
 * on the name, so the pipeline refuses first and says whose turn it is.
 */
describe("a branch that outlived its worktree", () => {
  /** The branch is there, nothing is checked out on it, nothing is recorded. */
  beforeEach(() => {
    workspace.branches.add(BRANCH);
  });

  it("hands the Ticket over at setup, naming the branch and what to do with it", async () => {
    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "handed-off",
      stage: "setup",
      // The summary the Run summary and the Run log carry, not just the comment.
      failure: `the branch ${BRANCH} already exists but no worktree of this repo is on it; delete it with \`git branch -D ${BRANCH}\` if the work on it is abandoned, or finish it by hand, then relabel the Ticket ready-for-agent`,
    });
    expect(handoffBody()).toContain(BRANCH);
    expect(handoffBody()).toContain("ready-for-agent");
  });

  it("does not create a worktree on a branch it cannot account for", async () => {
    await run();

    expect(workspace.calls).not.toContain(`createWorktree:${BRANCH}`);
    expect(runner.stages()).toEqual([]);
  });

  it("names no worktree, because the Ticket failed before it had one", async () => {
    await run();

    expect(handoffBody()).toContain(`Branch \`${BRANCH}\``);
    expect(handoffBody()).not.toContain("worktree `");
  });

  it("opens no draft PR, because there is no worktree to push out of", async () => {
    const outcome = await run();

    expect(outcome).not.toHaveProperty("pullRequest");
    expect(workspace.calls).not.toContain(`push:${BRANCH}`);
    expect(tracker.pullRequests).toEqual([]);
    expect(handoffBody()).not.toContain("PR #");
  });

  it("hands off the usual way, on a budget it has not spent", async () => {
    await run();

    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-human"]);
    expect(tracker.issue(TICKET).assignees).toEqual([]);
    expect(existsSync(statePath(repoRoot, TICKET))).toBe(false);
    expect(handoffBody()).not.toContain("after the fix budget was used");
  });

  it("reaches the same hand-off when a released Ticket's worktree has gone", async () => {
    writeTicketState(repoRoot, {
      ticket: TICKET,
      branch: BRANCH,
      state: "implemented",
      fixUsed: false,
      runId: "run-0",
      updatedAt: "2026-09-17T09:00:00.000Z",
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "setup" });
    expect(handoffBody()).toContain(`git branch -D ${BRANCH}`);
    expect(existsSync(statePath(repoRoot, TICKET))).toBe(false);
  });

  it("names the worktree instead when the branch is still checked out in one", async () => {
    // What a hand-off leaves: the worktree and the branch kept for a human, the
    // State file cleared. Relabelling the Ticket brings it back here.
    workspace.worktrees.set(worktree, BRANCH);

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "handed-off",
      stage: "setup",
      failure: `the branch ${BRANCH} already exists and is checked out at ${worktree}; \
finish the work there by hand, or throw it away with \`git worktree remove ${worktree} && \
git branch -D ${BRANCH}\`, then relabel the Ticket ready-for-agent`,
    });
    // The advice a branch git is holding cannot take: `git branch -D` on its own.
    expect(handoffBody()).not.toContain(`\`git branch -D ${BRANCH}\``);
    expect(workspace.calls).not.toContain(`createWorktree:${BRANCH}`);
    // The worktree is on disk here, so the hand-off still sends the human to it,
    // and the draft PR it can push out of is opened as it was before.
    expect(handoffBody()).toContain(`worktree \`${worktree}\``);
    expect(handoffBody()).toContain("PR #100 (draft)");
  });

  it("creates the worktree as before when the branch is not there", async () => {
    workspace.branches.delete(BRANCH);

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(workspace.calls).toContain(`createWorktree:${BRANCH}`);
  });
});

/**
 * The release and the resume in one test, once per Stage a rate limit can land
 * on: the second `run()` is the next Run meeting the Ticket the first one put
 * back on the Frontier, with the limit reset.
 */
describe("a Ticket released and then resumed", () => {
  /** Every Stage both Runs asked for, so the second Run's shortcuts are visible. */
  const stages = () => runner.stages();

  it("implements again when the limit stopped the implement Stage", async () => {
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    expect(await run()).toMatchObject({ outcome: "released", stage: "implement" });
    expect(await run()).toMatchObject({ outcome: "merged" });

    expect(stages()).toEqual(["implement", "implement", "verify"]);
    expect(workspace.calls.filter((call) => call.startsWith("createWorktree"))).toEqual([
      `createWorktree:${BRANCH}`,
    ]);
  });

  it("grades the work already on the branch when the limit stopped verify", async () => {
    runner.queue("verify", { ok: false, failure: "rate-limited" });

    expect(await run()).toMatchObject({ outcome: "released", stage: "verify" });
    expect(await run()).toMatchObject({ outcome: "merged" });

    expect(stages()).toEqual(["implement", "verify", "verify"]);
  });

  it("finds the failure again when the limit stopped the fix Stage", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
    runner.queue("fix", { ok: false, failure: "rate-limited" });

    expect(await run()).toMatchObject({ outcome: "released", stage: "fix" });
    // The Check passes on the second Run, so the budget it got back is unspent
    // and the fix Stage the limit stopped is not owed a second one.
    expect(await run()).toMatchObject({ outcome: "merged" });

    expect(stages()).toEqual(["implement", "fix", "verify"]);
  });

  it("rebases again when the limit stopped the conflict Stage", async () => {
    workspace.rebase = { ok: false, conflict: CONFLICT };
    workspace.rebaseStateAfterStage = UNRESOLVED;
    runner.queue("conflict", { ok: false, failure: "rate-limited" });

    expect(await run()).toMatchObject({ outcome: "released", stage: "rebase" });
    workspace.rebaseStateAfterStage = { resolved: true };
    expect(await run()).toMatchObject({ outcome: "merged" });

    expect(stages()).toEqual(["implement", "verify", "conflict", "verify", "conflict"]);
  });

  it("carries on in the progress comment the released Run opened", async () => {
    runner.queue("verify", { ok: false, failure: "rate-limited" });

    await run();
    await run();

    // One table, rewritten by the Run that resumed the Ticket: the pause the
    // first Run reported is not history the second one keeps.
    expect(progressTable()).not.toContain("⏸");
    expect(progressTable()).toContain("| merge | ✅ #100 |");
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
    issue.comments = [{ id: "c0", body: "Brief:\n\n- [ ] it works" }];

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
    issue.comments = [
      { id: "c0", body: "<!-- agent-pipeline:guard:body-only-blockers -->\n**Skipped.**" },
    ];

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

describe("the progress comment", () => {
  /** The Stage column, top to bottom. */
  function rows(): string[] {
    return [...progressTable().matchAll(/^\| ([a-z]+) \|/gm)].map((row) => row[1] as string);
  }

  it("creates one comment on the first Stage of a Ticket", async () => {
    runner.queue("implement", { ok: false, failure: "turn-capped" });

    await run();

    expect(tracker.comments.filter(({ body }) => body.startsWith(PROGRESS_MARKER))).toHaveLength(1);
    expect(progressTable()).toContain("| Stage | Outcome | Turns | Duration |");
    expect(rows()).toEqual(["implement"]);
  });

  it("edits that comment on every later Stage rather than adding another", async () => {
    await run();

    expect(tracker.comments.filter(({ body }) => body.startsWith(PROGRESS_MARKER))).toHaveLength(1);
    expect(rows()).toEqual(["implement", "checks", "verify", "ci", "merge"]);
    expect(tracker.updatedComments.length).toBeGreaterThan(0);
  });

  it("reports what each Stage did, with its turns", async () => {
    await run();

    expect(progressTable()).toContain("| implement | ✅ committed | 7 | 0m |");
    expect(progressTable()).toContain("| checks | ✅ passed | – | 0m |");
    expect(progressTable()).toContain("| verify | ✅ 1 met · 0 unverifiable | 7 | 0m |");
    expect(progressTable()).toContain("| merge | ✅ #100 | – | – |");
  });

  it("names the Run and the branch it is reporting on", async () => {
    await run();

    expect(progressTable()).toContain(`run \`run-1\` · \`${BRANCH}\``);
  });

  it("adds a row per pass when the fix budget buys a second one", async () => {
    workspace.failCheckOnce("npm test", "1 failing");

    await run();

    expect(rows()).toEqual([
      "implement",
      "checks",
      "fix",
      "checks",
      "verify",
      "ci",
      "merge",
    ]);
    expect(progressTable()).toContain("| checks | ❌ \`npm test\` failed | – | 0m |");
  });

  it("adds a conflict row and the Checks that re-grade what it resolved", async () => {
    workspace.conflictOnce(CONFLICT);

    await run();

    expect(rows()).toEqual([
      "implement",
      "checks",
      "verify",
      "conflict",
      "checks",
      "ci",
      "merge",
    ]);
    expect(progressTable()).toContain("| conflict | ✅ rebased | 7 | 0m |");
  });

  it("reuses the comment an earlier Run left on the Ticket", async () => {
    tracker.issue(TICKET).comments.push({
      id: "99",
      body: `${PROGRESS_MARKER}\n**agent-pipeline** · run \`run-0\` · \`${BRANCH}\`\n`,
    });

    await run();

    expect(tracker.comments.filter(({ body }) => body.startsWith(PROGRESS_MARKER))).toEqual([]);
    expect(tracker.updatedComments.every(({ id }) => id === "99")).toBe(true);
    expect(progressTable()).toContain("run \`run-1\`");
  });

  it("merges a Ticket the tracker would not take a progress comment for", async () => {
    tracker.comment = async () => {
      throw new Error("502 from GitHub");
    };

    expect(await run()).toMatchObject({ outcome: "merged" });
  });
});

describe("what stays a separate comment", () => {
  it("posts the hand-off and its evidence beside the table, not inside it", async () => {
    workspace.failCheck("npm test", "1 failing · expected true to be false");

    await run();

    const handoff = tracker.comments.filter(({ body }) =>
      body.startsWith("<!-- agent-pipeline:handoff -->"),
    );
    expect(handoff).toHaveLength(1);
    expect(handoff[0]?.body).toContain("1 failing · expected true to be false");

    const progress = tracker.issue(TICKET).comments.find(({ body }) =>
      body.startsWith(PROGRESS_MARKER),
    );
    expect(progress?.body).toContain("| checks | ❌ \`npm test\` failed |");
    expect(progress?.body).not.toContain("expected true to be false");
  });

  it("leaves a guard warning a comment of its own, with no table beside it", async () => {
    tracker.issue(TICKET).body = "## What to build\n\nSomething good.";

    await run();

    expect(tracker.comments.map(({ body }) => body.split("\n")[0])).toEqual([
      "<!-- agent-pipeline:guard:no-criteria -->",
    ]);
  });
});

describe("ticking the Acceptance Criteria a merge proved", () => {
  const MIXED_BODY = "- [ ] it works\n- [ ] the docs say so\n";

  beforeEach(() => {
    tracker.issue(TICKET).body = MIXED_BODY;
    runner.queue("verify", { result: MIXED_VERDICT });
  });

  it("ticks the met criteria in the body and leaves the unverifiable ones", async () => {
    await run();

    expect(tracker.issue(TICKET).body).toBe("- [x] it works\n- [ ] the docs say so\n");
  });

  it("ticks criteria a triage comment posted instead of the body", async () => {
    tracker.issue(TICKET).body = "## What to build\n\nSomething good.";
    tracker.issue(TICKET).comments.push({ id: "77", body: "Brief:\n\n- [ ] it works\n" });

    await run();

    expect(tracker.updatedComments).toContainEqual({
      id: "77",
      body: "Brief:\n\n- [x] it works\n",
    });
  });

  it("leaves the body alone when the Verdict proved nothing that is in it", async () => {
    tracker.issue(TICKET).body = "- [ ] something nobody graded\n";

    await run();

    expect(tracker.calls).not.toContain(`updateIssueBody:${TICKET}`);
  });

  it("ticks nothing until the Ticket has actually merged", async () => {
    workspace.failCheck("npm test", "1 failing");

    await run();

    expect(tracker.issue(TICKET).body).toBe(MIXED_BODY);
  });

  it("reports a merged Ticket even when the tick cannot be written", async () => {
    tracker.updateIssueBody = async () => {
      throw new Error("issue is locked");
    };

    expect(await run()).toMatchObject({ outcome: "merged", pullRequest: 100 });
  });
});

/** The one comment the Stages share, as it stands on the Ticket now. */
function progressTable(): string {
  const progress = tracker
    .issue(TICKET)
    .comments.filter(({ body }) => body.startsWith(PROGRESS_MARKER));
  if (progress.length !== 1) {
    throw new Error(`expected one progress comment, found ${progress.length}`);
  }
  return progress[0]?.body as string;
}

describe("Notes a Stage makes", () => {
  const OTHER = 7;
  const noteResult = (notes: unknown[]) => stageResult({ result: { notes } });

  beforeEach(() => {
    tracker.addIssue({ number: OTHER, title: "Progress comment" });
  });

  it("posts a Note on the Ticket it names", async () => {
    runner.queue("implement", noteResult([{ ticket: OTHER, note: "the help drifts" }]));

    await run();

    expect(tracker.comments).toContainEqual({
      issue: OTHER,
      body: "<!-- agent-pipeline:note -->\nFrom #2 implement\n\nthe help drifts\n",
    });
  });

  it("opens a needs-triage issue for a Note that names no Ticket", async () => {
    runner.queue("implement", noteResult([{ note: "Nothing cleans up worktrees." }]));

    await run();

    expect(tracker.createdIssues).toEqual([
      {
        title: "Nothing cleans up worktrees",
        body: "From #2 implement\n\nNothing cleans up worktrees.\n",
        labels: ["needs-triage"],
      },
    ]);
  });

  it("opens it under the label this repo calls needs-triage", async () => {
    runner.queue("implement", noteResult([{ note: "no cleanup" }]));

    await run({
      labels: { ...config().labels, needsTriage: "inbox" },
    });

    expect(tracker.createdIssues[0]?.labels).toEqual(["inbox"]);
  });

  it("escapes a checkbox so the guards never read a Note as criteria", async () => {
    runner.queue("implement", noteResult([{ ticket: OTHER, note: "- [ ] rename the flag" }]));

    await run();

    const note = tracker.issue(OTHER).comments.at(-1)?.body as string;
    expect(note).toContain("- \\[ \\] rename the flag");
    expect(new RegExp(UNCHECKED_BOX, "m").test(note)).toBe(false);
  });

  it("reports every Note it routed, with where it went", async () => {
    runner.queue(
      "implement",
      noteResult([{ ticket: OTHER, note: "the help drifts" }, { note: "no cleanup" }]),
    );

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "merged",
      notes: [
        { origin: TICKET, stage: "implement", issue: OTHER, opened: false, note: "the help drifts" },
        { origin: TICKET, stage: "implement", issue: 200, opened: true, note: "no cleanup" },
      ],
    });
  });

  it("routes the fix Stage's Notes too", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
    runner.queue("fix", noteResult([{ ticket: OTHER, note: "found while fixing" }]));

    const outcome = await run();

    expect(outcome).toMatchObject({
      notes: [{ origin: TICKET, stage: "fix", issue: OTHER, note: "found while fixing" }],
    });
  });

  it("routes a failed Stage's Notes before handing the Ticket off", async () => {
    runner.queue("implement", {
      ...noteResult([{ ticket: OTHER, note: "noticed before I died" }]),
      ok: false,
      failure: "turn-capped",
    });

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "handed-off",
      stage: "implement",
      notes: [{ issue: OTHER, note: "noticed before I died" }],
    });
  });

  it("sends a Note to triage when the Ticket it named will not take it", async () => {
    runner.queue("implement", noteResult([{ ticket: 404, note: "the flag is wrong" }]));

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "merged",
      notes: [{ issue: 200, opened: true, note: "the flag is wrong" }],
    });
  });

  it("merges the Ticket anyway when a Note reaches nowhere at all", async () => {
    tracker.createIssue = async () => {
      throw new Error("gh: connection reset");
    };
    runner.queue("implement", noteResult([{ ticket: 404, note: "lost" }]));

    expect(await run()).toMatchObject({ outcome: "merged", notes: [] });
  });
});

describe("a Stage with no Notes", () => {
  it("merges the Ticket writing nothing but the usual", async () => {
    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged", notes: [] });
    expect(tracker.createdIssues).toEqual([]);
    expect(notices()).toEqual([]);
  });

  it("is not failed for emitting no structured output at all", async () => {
    runner.queue("implement", stageResult({ result: undefined }));

    expect(await run()).toMatchObject({ outcome: "merged" });
  });

  it("writes nothing for an empty notes list", async () => {
    runner.queue("implement", stageResult({ result: { notes: [] } }));

    await run();

    expect(tracker.createdIssues).toEqual([]);
    expect(notices()).toEqual([]);
  });
});

function handoffBody(): string {
  const comment = tracker.comments.at(-1);
  if (!comment) throw new Error("no hand-off comment was written");
  return comment.body;
}
