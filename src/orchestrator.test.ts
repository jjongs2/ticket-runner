import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { UNCHECKED_BOX } from "./acceptance-criteria.js";
import { resolveBaseBranch } from "./base-branch.js";
import type { Config } from "./config.js";
import type { HostKind } from "./host.js";
import { Landing } from "./landing.js";
import { StandingNotes } from "./notes.js";
import { processTicket } from "./orchestrator.js";
import { PROGRESS_MARKER } from "./progress.js";
import { HANDOFF_MARKER, HANDOFF_TAKEN_LINE, handoffComment } from "./templates.js";
import type { Pipeline, TicketOutcome } from "./orchestrator.js";
import type { StageName } from "./ports/agent-runner.js";
import type { TicketState } from "./ports/workspace.js";
import { FakeAgentRunner, FakeTracker, FakeWorkspace, stageResult } from "./testing/fakes.js";
import { settle } from "./testing/settle.js";

/** The Version this Run is, as the CLI resolves it once and hands it down. */
const VERSION = "0.4.0+331d79c";

const TICKET = 2;
const BRANCH = "agent/2-skeleton-one-ticket-end-to-end";
const URL = "https://github.com/acme/repo/issues/2";
const CONFLICT = "CONFLICT (content): Merge conflict in src/cli.ts";
const UNRESOLVED = { resolved: false, unresolved: "a rebase is still in progress" } as const;

function config(overrides: Partial<Config> = {}): Config {
  return {
    lanes: 1,
    checks: ["npm test", "npm run typecheck"],
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
/** The repo root the Run is given; nothing under it is read or written. */
const repoRoot = "/repo";
/** Where this Ticket's Stages run, under the repo root the Run was given. */
let worktree: string;
/** The Run log, for the lines a Ticket is expected to print — or not to. */
let logged: string[];

beforeEach(() => {
  logged = [];
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
    seen.push({ stage: request.stage, state: workspace.state(TICKET) });
    return runStage(request);
  };
  return seen;
}

/**
 * One Ticket, through a pipeline wired the way the CLI wires one: the base
 * branch is resolved from the tracker and the config before the Ticket starts,
 * so a fake Tracker on `master` is enough to drive the whole Run there.
 */
async function run(
  overrides: Partial<Config> = {},
  host: HostKind = "workstation",
): Promise<TicketOutcome> {
  const settings = config(overrides);
  return await processTicket(
    {
      tracker,
      runner,
      workspace,
      config: settings,
      repoRoot,
      runId: "run-1",
      version: VERSION,
      host,
      baseBranch: await resolveBaseBranch(tracker, settings),
      landing: new Landing(),
      standingNotes: new StandingNotes(),
      log: (line) => logged.push(line),
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

  it("squash-merges, pulls the base branch and cleans the worktree and remote branch up", async () => {
    await run();

    expect(tracker.calls).toContain("squashMerge:100");
    expect(workspace.calls.slice(-3)).toEqual([
      "pullBase",
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

  it("points a workstation's reader at the Run's directory, which is still there", async () => {
    await run();

    expect(tracker.pullRequest(100).body).toContain(
      `Run \`run-1\` · transcripts in \`.agent-pipeline/runs/run-1/${TICKET}/\``,
    );
  });

  it("names the Run alone on a cloud Host, whose run directory goes with its session", async () => {
    await run({}, "cloud");

    const body = tracker.pullRequest(100).body;
    expect(body.endsWith("</details>\n\nRun `run-1`\n")).toBe(true);
    expect(body).not.toContain("transcripts");
  });

  it("clears in-progress after the merge and keeps the assignee as the record", async () => {
    await run();

    expect(tracker.issue(TICKET).labels).toEqual([]);
    expect(tracker.issue(TICKET).assignees).toEqual(["pipeline-user"]);
    expect(notices()).toEqual([]);
  });
});

describe("the Target's base branch", () => {
  it("branches, targets and pulls whatever the Target calls its default", async () => {
    tracker.defaultBranchName = "master";

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(workspace.branchedFrom).toEqual(["master"]);
    expect(workspace.rebasedOnto).toEqual(["master"]);
    expect(tracker.pullRequest(100).base).toBe("master");
    expect(workspace.pulledBase).toEqual(["master", "master"]);
  });

  it("hands every operation that names a branch the one branch it resolved", async () => {
    tracker.defaultBranchName = "master";
    workspace.conflictOnce(CONFLICT);

    await run();

    // The reads that only compute a range included: the commits the pull
    // request title and the squash body are taken from are `master..branch`.
    expect([...new Set(workspace.basesGiven)]).toEqual(["master"]);
  });

  it("lets the config file's baseBranch win over the Target's default", async () => {
    tracker.defaultBranchName = "master";

    await run({ baseBranch: "release" });

    expect(workspace.branchedFrom).toEqual(["release"]);
    expect(tracker.pullRequest(100).base).toBe("release");
  });

  it("tells the Stages the branch it resolved, not `main`", async () => {
    tracker.defaultBranchName = "master";
    workspace.conflictOnce(CONFLICT);

    await run();

    const prompts = runner.requests.map((request) => request.prompt);
    expect(prompts.join("\n")).not.toContain("`main`");
    expect(prompts.some((prompt) => prompt.includes("the squash commit on `master`"))).toBe(
      true,
    );
    expect(prompts.some((prompt) => prompt.includes("rebasing it onto `master`"))).toBe(true);
  });

  it("hands the Ticket off naming the branch the conflict Stage left unrebased", async () => {
    tracker.defaultBranchName = "master";
    workspace.conflictOnce(CONFLICT);
    workspace.rebaseStateAfterStage = UNRESOLVED;

    await run();

    const fix = runner.requests.find((request) => request.stage === "fix");
    expect(fix?.prompt).toContain("the branch conflicts with master");
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

    expect(workspace.calls.indexOf("rebase")).toBeLessThan(
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
  it("passes each Stage its configured model, effort, turn and time limits", async () => {
    await run();

    expect(runner.requests[0]).toMatchObject({
      stage: "implement",
      model: "claude-opus-5-5",
      effort: "high",
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

  it("gives a Stage the effort its own config names", async () => {
    const stages = config().stages;
    await run({ stages: { ...stages, verify: { ...stages.verify, effort: "max" } } });

    expect(runner.requests[0]).toMatchObject({ stage: "implement", effort: "high" });
    expect(runner.requests[1]).toMatchObject({ stage: "verify", effort: "max" });
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
      // Each Check gets the whole limit, not a share of it.
      { command: "npm test", cwd: worktree, timeoutMs: 15 * 60_000 },
      { command: "npm run typecheck", cwd: worktree, timeoutMs: 15 * 60_000 },
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

  it("spends the fix budget on a Check that timed out and says the limit was the cause", async () => {
    workspace.timeOutCheckOnce("npm test", "RUN  v3.0.0 /repo");

    await run();

    expect(progressTable()).toContain("| checks | ❌ `npm test` timed out |");
    expect(runner.stages()).toEqual(["implement", "fix", "verify"]);
    const prompt = runner.prompts("fix")[0] as string;
    expect(prompt).toContain("Check `npm test` timed out");
    expect(prompt).toContain("RUN  v3.0.0 /repo");
    expect(prompt).toMatch(/killed after 15 minutes/);
  });

  it("hands a timed-out Check off with the same evidence once the budget is spent", async () => {
    workspace.timeOutCheck("npm test", "RUN  v3.0.0 /repo");

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "checks" });
    expect(handoffBody()).toContain("Check `npm test` timed out");
    expect(handoffBody()).toContain("RUN  v3.0.0 /repo");
    expect(handoffBody()).toMatch(/killed after 15 minutes/);
  });

  it("names the configured limit, not the default, when the config moves it", async () => {
    workspace.timeOutCheck("npm test", "");

    await run({ checkTimeoutMinutes: 2 });

    expect(workspace.ranChecks[0]?.timeoutMs).toBe(2 * 60_000);
    expect(handoffBody()).toMatch(/killed after 2 minutes/);
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

    // The push the pull request is opened from, which is the last one.
    expect(workspace.calls.indexOf("rebase")).toBeLessThan(
      workspace.calls.lastIndexOf(`push:${BRANCH}`),
    );
  });

  it("brings the base branch up to the remote before it rebases", async () => {
    await run();

    expect(workspace.calls.indexOf("pullBase")).toBeLessThan(
      workspace.calls.indexOf("rebase"),
    );
  });

  it("hands off rather than rebase onto a base branch it could not bring up", async () => {
    workspace.pullBaseFailure = new Error("git pull --ff-only exited 128: Not possible to fast-forward");

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "rebase" });
    expect(workspace.calls).not.toContain("rebase");
    expect(tracker.calls).not.toContain("squashMerge:100");
    expect(handoffBody()).toContain("Not possible to fast-forward");
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
    // The push the pull request is opened from, which is the last one.
    expect(workspace.calls.lastIndexOf("runCheck:npm run typecheck")).toBeLessThan(
      workspace.calls.lastIndexOf(`push:${BRANCH}`),
    );
  });

  it("takes a Stage that finished the rebase and only then ran out of turns", async () => {
    workspace.conflictOnce(CONFLICT);
    runner.queue("conflict", { ok: false, failure: "turn-capped" });

    expect(await run()).toMatchObject({ outcome: "merged" });
  });

  it("spends the fix budget when the conflict outlives the Stage", async () => {
    workspace.rebaseOutcome = { ok: false, conflict: CONFLICT };
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
    workspace.rebaseOutcome = { ok: false, conflict: CONFLICT };
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
    expect(workspace.pulledBase).toEqual([]);
  });
});

/**
 * What a human reads a hand-off by once the Host it happened on is gone: the
 * branch and the Stages' transcripts, both on the remote.
 */
describe("the transcripts a hand-off keeps on the remote", () => {
  const KEPT = "- Transcripts: `ticket-2/run-1/` on the `agent-pipeline/state` branch";

  it("keeps this Run's beside the State, and the comment says where they and the branch are", async () => {
    workspace.failCheck("npm test", "FAIL src/a.test.ts");

    expect(await run()).toMatchObject({ outcome: "handed-off" });
    expect(workspace.transcripts.get(TICKET)).toEqual(["run-1"]);
    expect(workspace.state(TICKET)).toBeDefined();
    expect(handoffBody()).toContain(`- Branch \`${BRANCH}\` on the remote · worktree`);
    expect(handoffBody()).toContain(KEPT);
  });

  it("keeps them after the rest of the hand-off is written, so the kept State is current", async () => {
    workspace.failCheck("npm test", "FAIL src/a.test.ts");
    let stateWhenKept: TicketState | undefined;
    const keep = workspace.keepTranscripts.bind(workspace);
    workspace.keepTranscripts = async (ticket, runId) => {
      stateWhenKept = workspace.state(ticket);
      return keep(ticket, runId);
    };

    await run();

    // The draft PR is part of the State; transcripts kept before it would sit
    // beside a State a resuming Run opens a second pull request over.
    expect(stateWhenKept).toMatchObject({ pullRequest: 100 });
  });

  it("names them in the draft PR's body too, and not the directory on this Host", async () => {
    workspace.failCheck("npm test", "FAIL src/a.test.ts");

    await run({}, "cloud");

    const body = tracker.pullRequest(100).body;
    expect(tracker.pullRequest(100).draft).toBe(true);
    expect(body).toContain(
      "Run `run-1` · transcripts in `ticket-2/run-1/` on the `agent-pipeline/state` branch",
    );
    expect(body).not.toContain(".agent-pipeline/runs/");
  });

  it("names none in the draft PR's body when the remote will not take them", async () => {
    workspace.failCheck("npm test", "FAIL src/a.test.ts");
    workspace.keepTranscripts = async () => {
      throw new Error("remote rejected");
    };

    await run();

    const body = tracker.pullRequest(100).body;
    expect(body.endsWith("evidence.\n\nRun `run-1`\n")).toBe(true);
    expect(body).not.toContain("transcripts");
  });

  it("names them in a PR that was open before the hand-off made it a draft", async () => {
    tracker.ci = { state: "failed", summary: "checks/build failed", excerpt: "" };

    await run();

    const body = tracker.pullRequest(100).body;
    expect(tracker.calls).toContain("convertPullRequestToDraft:100");
    expect(body).toContain("**Handed off at ci.**");
    expect(body).toContain(
      "Run `run-1` · transcripts in `ticket-2/run-1/` on the `agent-pipeline/state` branch",
    );
    expect(body).not.toContain(".agent-pipeline/runs/");
  });

  it("names none in a PR made a draft when the remote will not take them", async () => {
    tracker.ci = { state: "failed", summary: "checks/build failed", excerpt: "" };
    workspace.keepTranscripts = async () => {
      throw new Error("remote rejected");
    };

    await run();

    const body = tracker.pullRequest(100).body;
    expect(body.endsWith("evidence.\n\nRun `run-1`\n")).toBe(true);
    expect(body).not.toContain("transcripts");
  });

  it("still hands the Ticket off when the draft PR's body cannot be rewritten", async () => {
    workspace.failCheck("npm test", "FAIL src/a.test.ts");
    tracker.updatePullRequestBody = async () => {
      throw new Error("gh: 502");
    };

    expect(await run()).toMatchObject({ outcome: "handed-off", pullRequest: 100 });
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-human"]);
    expect(handoffBody()).toContain(KEPT);
    expect(logged.some((line) => line.includes("gh: 502"))).toBe(true);
  });

  it("keeps none for a Ticket that merges", async () => {
    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(workspace.transcripts.has(TICKET)).toBe(false);
  });

  it("clears those an earlier hand-off kept once the Ticket, handed back, merges", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
    expect(await run()).toMatchObject({ outcome: "handed-off" });
    expect(workspace.transcripts.has(TICKET)).toBe(true);
    tracker.issue(TICKET).labels = ["ready-for-agent"];

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(workspace.transcripts.has(TICKET)).toBe(false);
    // The merge took what the draft's body pointed at, so the body goes too.
    expect(tracker.pullRequest(100).body).not.toContain("agent-pipeline/state");
  });

  it("keeps none for a released Ticket, which nobody has to look into", async () => {
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    expect(await run()).toMatchObject({ outcome: "released" });
    expect(workspace.transcripts.has(TICKET)).toBe(false);
  });

  it("keeps none where the hand-off leaves no State, and says the branch is only here", async () => {
    // A branch in the way at setup: no Stage of this Run ran, and the branch
    // is a human's, which never went to the remote.
    workspace.branches.add(BRANCH);

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "setup" });
    expect(workspace.transcripts.has(TICKET)).toBe(false);
    expect(handoffBody()).not.toContain("Transcripts");
    expect(handoffBody()).toContain(`- Branch \`${BRANCH}\`\n`);
  });

  it("still hands the Ticket off, naming none, when the remote will not take them", async () => {
    workspace.failCheck("npm test", "FAIL src/a.test.ts");
    workspace.keepTranscripts = async () => {
      throw new Error("remote rejected");
    };

    expect(await run()).toMatchObject({ outcome: "handed-off" });
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-human"]);
    expect(handoffBody()).not.toContain("Transcripts");
    expect(logged.some((line) => line.includes("remote rejected"))).toBe(true);
  });
});

/**
 * The branch carries a Ticket's work between Hosts, so every Stage that commits
 * pushes it: a Host that vanishes after that loses nothing (ADR-0004).
 */
describe("pushing the branch after every committing Stage", () => {
  /** Each push of the branch, named by the Stage that last ran before it. */
  function pushesAfter(): (StageName | "none")[] {
    const seen: (StageName | "none")[] = [];
    let last: StageName | "none" = "none";
    const runStage = runner.run.bind(runner);
    runner.run = async (request) => {
      const result = await runStage(request);
      last = request.stage;
      return result;
    };
    const push = workspace.push.bind(workspace);
    workspace.push = async (cwd, branch) => {
      seen.push(last);
      await push(cwd, branch);
    };
    return seen;
  }

  it("pushes once the implement Stage has committed, before the Checks grade it", async () => {
    const pushed = pushesAfter();

    await run();

    expect(pushed[0]).toBe("implement");
    expect(workspace.calls.indexOf(`push:${BRANCH}`)).toBeLessThan(
      workspace.calls.indexOf("runCheck:npm test"),
    );
  });

  it("pushes what an implement Stage the rate limit stopped had committed", async () => {
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "released", stage: "implement" });
    expect(workspace.pushes).toEqual([{ cwd: worktree, branch: BRANCH }]);
    expect(workspace.remoteBranches.has(BRANCH)).toBe(true);
  });

  it("pushes nothing after an implement Stage that committed nothing", async () => {
    workspace.commits = [];
    // Nothing for the hand-off to push either, so any push is the Stage's.
    workspace.push = async () => {
      throw new Error("no push was expected");
    };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "implement" });
    expect(logged.some((line) => line.includes("could not push"))).toBe(false);
  });

  it("pushes once the fix Stage has committed, before the Checks grade it again", async () => {
    const pushed = pushesAfter();
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");

    await run();

    expect(pushed).toContain("fix");
    const calls = workspace.calls;
    const fixPush = calls.indexOf(`push:${BRANCH}`, calls.indexOf(`push:${BRANCH}`) + 1);
    expect(fixPush).toBeLessThan(calls.lastIndexOf("runCheck:npm test"));
  });

  it("pushes once the conflict Stage has finished the rebase", async () => {
    const pushed = pushesAfter();
    workspace.conflictOnce(CONFLICT);

    await run();

    expect(pushed).toContain("conflict");
    const calls = workspace.calls;
    expect(calls.indexOf(`push:${BRANCH}`, calls.indexOf("rebaseState"))).toBeLessThan(
      calls.lastIndexOf("runCheck:npm test"),
    );
  });

  it("pushes nothing for a conflict the Stage left unresolved", async () => {
    workspace.rebaseOutcome = { ok: false, conflict: CONFLICT };
    workspace.rebaseStateAfterStage = UNRESOLVED;

    await run();

    // Between the Stage coming back and the abort that puts the branch back
    // where it was, which is a tip the remote already has.
    const calls = workspace.calls;
    const afterStage = calls.slice(calls.indexOf("rebaseState"), calls.indexOf("abortRebase"));
    expect(afterStage).not.toContain(`push:${BRANCH}`);
  });

  it("carries on when the push is refused, and says so in the Run log", async () => {
    const push = workspace.push.bind(workspace);
    let refused = false;
    workspace.push = async (cwd, branch) => {
      if (!refused) {
        refused = true;
        throw new Error("remote rejected");
      }
      await push(cwd, branch);
    };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(logged).toContain(`#${TICKET} could not push ${BRANCH}: remote rejected`);
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

    // After each of the two Stages that committed, and before each wait for CI.
    expect(workspace.pushes).toHaveLength(4);
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

  it("takes its own model, effort, turn and time limits, and its own extra prompt", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");

    await run({
      stages: {
        ...config().stages,
        fix: {
          model: "claude-sonnet-5",
          effort: "low",
          maxTurns: 12,
          maxMinutes: 9,
          extraPrompt: "Keep the diff small.",
        },
      },
    });

    expect(fixRequest()).toMatchObject({
      stage: "fix",
      model: "claude-sonnet-5",
      effort: "low",
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

describe("uncommitted work", () => {
  /** How many Checks had run by the time the fix Stage started. */
  let checksBeforeFix: number | undefined;

  beforeEach(() => {
    checksBeforeFix = undefined;
    // A fix Stage that commits what it found and leaves the worktree clean.
    runner.leaves("fix", () => {
      checksBeforeFix = workspace.ranChecks.length;
      workspace.commits.push("fix(cli): commit the review fixes (#2)");
      workspace.uncommitted = [];
    });
  });

  it("sends a fix Stage in with the paths before any Check grades the worktree", async () => {
    runner.leaves("implement", () => {
      workspace.uncommitted = ["src/cli.ts", "src/new.test.ts"];
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["implement", "fix", "verify"]);
    expect(checksBeforeFix).toBe(0);
    const prompt = runner.prompts("fix")[0] as string;
    expect(prompt).toMatch(/left changes .*never committed/i);
    expect(prompt).toContain("src/cli.ts");
    expect(prompt).toContain("src/new.test.ts");
    expect(progressTable()).toContain("| checks | ❌ uncommitted work |");
  });

  it("spends the fix budget on it", async () => {
    runner.leaves("implement", () => {
      workspace.uncommitted = ["src/cli.ts"];
    });
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "verify" });
    expect(handoffBody()).toContain("after the fix budget was used");
  });

  it("hands the Ticket off when the fix Stage leaves some too, keeping the changes", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
    runner.leaves("fix", () => {
      workspace.commits.push("fix(cli): mend the thing (#2)");
      workspace.uncommitted = ["src/cli.ts"];
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "checks" });
    expect(runner.stages()).toEqual(["implement", "fix"]);
    expect(workspace.ranChecks.map((check) => check.command)).toEqual(["npm test"]);
    expect(handoffBody()).toContain("the worktree holds changes no commit carries");
    expect(handoffBody()).toContain("src/cli.ts");
    expect(handoffBody()).toContain("after the fix budget was used");
    expect(workspace.uncommitted).toEqual(["src/cli.ts"]);
    expect(workspace.calls.some((call) => call.startsWith("discardChanges"))).toBe(false);
  });

  it("reaches the Checks exactly as before from a clean worktree", async () => {
    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["implement", "verify"]);
    const calls = workspace.calls;
    expect(calls).toContain(`uncommittedPaths:${worktree}`);
    expect(calls.indexOf(`uncommittedPaths:${worktree}`)).toBeLessThan(calls.indexOf("runCheck:npm test"));
    expect(progressTable()).not.toContain("uncommitted");
  });

  it("still hands off an implement Stage that left no commits at all", async () => {
    runner.leaves("implement", () => {
      workspace.commits = [];
      workspace.uncommitted = ["src/cli.ts"];
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "implement" });
    expect(handoffBody()).toContain("the implement Stage left no new commits on the branch");
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
  const state = () => workspace.state(TICKET);

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
    workspace.rebaseOutcome = { ok: false, conflict: CONFLICT };
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

  it("leaves a State file behind when the Ticket is handed off instead", async () => {
    runner.queue("implement", { ok: false, failure: "turn-capped" });

    // A hand-off keeps the file too; the label is what tells the two apart, and
    // a Release is not the only ending a later Run resumes from.
    expect(await run()).toMatchObject({ outcome: "handed-off" });
    expect(state()).toMatchObject({ state: "claimed", branch: BRANCH });
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
        version: VERSION,
        updatedAt: expect.any(String),
      },
    });
  });

  it("names the Version that wrote it, on every write", async () => {
    const seen = stateAtEachStage();

    await run();

    // Every stamp of one Run is the same string, and there is at least one.
    expect(seen.length).toBeGreaterThan(0);
    expect([...new Set(seen.map(({ state }) => state?.version))]).toEqual([VERSION]);
  });

  it("is on disk before the Claim reaches the board", async () => {
    let atClaim: TicketState | undefined;
    const assign = tracker.assign.bind(tracker);
    tracker.assign = async (number, assignee) => {
      atClaim = workspace.state(TICKET);
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
    workspace.commitSubjects = async (branch, base) => {
      atCount ??= workspace.state(TICKET);
      return commitSubjects(branch, base);
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
    // Storage that will not take the State, so the very first write fails.
    workspace.stateWriteFailure = new Error("ENOTDIR: not a directory");

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
      atCi = workspace.state(TICKET);
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
    expect(workspace.states.has(TICKET)).toBe(false);
  });

  it("is kept once the Ticket is handed off, with the Fix budget given back", async () => {
    workspace.failCheck("npm test", "FAIL src/a.test.ts");

    // The fix Stage ran and failed the Checks a second time, so the budget was
    // spent — and the file says otherwise, because the Ticket only comes back
    // through a human's hands and the fresh budget is for what they did to it.
    expect(await run()).toMatchObject({ outcome: "handed-off" });
    expect(workspace.state(TICKET)).toMatchObject({
      state: "implemented",
      branch: BRANCH,
      fixUsed: false,
    });
  });

  it("is never written for a candidate a guard passed over", async () => {
    tracker.issue(TICKET).subIssues = 3;

    expect(await run()).toMatchObject({ outcome: "skipped", reason: "spec" });
    expect(workspace.states.has(TICKET)).toBe(false);
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
    workspace.recordState(state);
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
    // Kept, and with the budget back: the human this is handed to is the reason
    // the next Run gets to buy a fix Stage again.
    expect(workspace.state(TICKET)).toMatchObject({ fixUsed: false });
  });

  it("still pushes and opens a draft PR when it is handed off in its own worktree", async () => {
    strandedTicket({ fixUsed: true });
    workspace.failCheck("npm test", "FAIL src/a.test.ts");

    const outcome = await run();

    // The worktree is one this Run was resumed into, so a Stage of it could
    // have left work there and the hand-off pushes as it always did.
    expect(outcome).toMatchObject({ outcome: "handed-off", pullRequest: 100 });
    expect(workspace.pushes).toEqual([{ cwd: worktree, branch: BRANCH }]);
    expect(handoffBody()).toContain("PR #100 (draft)");
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
    expect(workspace.states.has(TICKET)).toBe(true);
  });

  it("is released again, with its state current, when the rate limit is still on", async () => {
    strandedTicket();
    runner.queue("verify", { ok: false, failure: "rate-limited" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "released", stage: "verify" });
    expect(workspace.state(TICKET)).toMatchObject({
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
    workspace.recordState(state);
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
      base: "main",
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

    expect(workspace.states.has(TICKET)).toBe(false);
  });

  it("keeps the State file when the resumed Ticket is handed off", async () => {
    released({ fixUsed: true });
    workspace.failCheck("npm test", "FAIL src/a.test.ts");

    await run();

    expect(workspace.state(TICKET)).toMatchObject({
      state: "implemented",
      fixUsed: false,
    });
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-human"]);
  });

  it("starts the Ticket over when the worktree and the branch are both gone", async () => {
    // Nothing is seeded on the workspace: the human who removed the worktree
    // removed the branch with it, so there is nothing in the way of a fresh one.
    workspace.recordState({
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
    expect(workspace.states.has(TICKET)).toBe(false);
  });
});

/**
 * A resumed Ticket carries on from its branch on the remote, whichever Host
 * pushed it, rather than from whatever worktree this Host happens to have
 * (ADR-0004).
 */
describe("resuming from the remote branch", () => {
  /** The State a Run on some Host recorded, and the branch it pushed. */
  function recorded(overrides: Partial<TicketState> = {}): void {
    workspace.recordState({
      ticket: TICKET,
      branch: BRANCH,
      state: "implemented",
      fixUsed: false,
      runId: "run-0",
      updatedAt: "2026-09-17T09:00:00.000Z",
      ...overrides,
    });
    workspace.remoteBranches.add(BRANCH);
  }

  /** A worktree a Run on this Host left behind. */
  function leftover(): void {
    workspace.worktrees.set(worktree, BRANCH);
    workspace.branches.add(BRANCH);
  }

  describe("with no worktree on this Host", () => {
    it("makes one from the remote branch and carries on from the state it reached", async () => {
      recorded();

      const outcome = await run();

      expect(outcome).toMatchObject({ outcome: "merged" });
      expect(workspace.calls).toContain(`worktreeFromRemote:${BRANCH}`);
      expect(workspace.calls).not.toContain(`createWorktree:${BRANCH}`);
      expect(runner.stages()).toEqual(["verify"]);
      expect(workspace.ranChecks.map((check) => check.cwd)).toEqual([worktree, worktree]);
    });

    it("runs the implement Stage in it when that is where the Ticket stopped", async () => {
      recorded({ state: "claimed" });

      await run();

      expect(runner.stages()).toEqual(["implement", "verify"]);
      expect(runner.requests[0]?.cwd).toBe(worktree);
      expect(workspace.calls).not.toContain(`createWorktree:${BRANCH}`);
    });

    it("resumes a Stranded Ticket another Host left, keeping its Claim", async () => {
      recorded();
      const issue = tracker.issue(TICKET);
      issue.assignees = ["pipeline-user"];
      issue.labels = ["in-progress"];

      const outcome = await run();

      expect(outcome).toMatchObject({ outcome: "merged" });
      expect(runner.stages()).toEqual(["verify"]);
      expect(tracker.calls).not.toContain(`assign:${TICKET}:pipeline-user`);
    });

    it("takes the Ticket from the top only when its branch is gone from the remote", async () => {
      recorded({ fixUsed: true });
      workspace.remoteBranches.delete(BRANCH);

      const outcome = await run();

      expect(outcome).toMatchObject({ outcome: "merged" });
      expect(workspace.calls).toContain(`createWorktree:${BRANCH}`);
      expect(runner.stages()).toEqual(["implement", "verify"]);
      expect(logged).toContain(
        `#${TICKET} was resumable, but ${BRANCH} is neither in ${worktree} nor on the remote`,
      );
    });
  });

  it("hands the Ticket off at setup when its worktree cannot be made ready", async () => {
    recorded();
    workspace.worktreeFromRemote = async () => {
      throw new Error("fatal: unable to access the remote");
    };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "setup" });
    expect(handoffBody()).toContain("fatal: unable to access the remote");
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-human"]);
    expect(runner.stages()).toEqual([]);
    // Nothing about the work is known to be wrong, so a relabel resumes it.
    expect(workspace.state(TICKET)).toMatchObject({ state: "implemented" });
  });

  describe("with a worktree left on this Host", () => {
    it("uses one that contains the remote branch as it is", async () => {
      recorded();
      leftover();

      const outcome = await run();

      expect(outcome).toMatchObject({ outcome: "merged" });
      expect(runner.stages()).toEqual(["verify"]);
      expect(workspace.calls).not.toContain(`createWorktree:${BRANCH}`);
      expect(workspace.pushes[0]).toEqual({ cwd: worktree, branch: BRANCH });
    });

    it("uses one whose branch never reached the remote", async () => {
      recorded({ state: "claimed" });
      workspace.remoteBranches.delete(BRANCH);
      leftover();

      const outcome = await run();

      expect(outcome).toMatchObject({ outcome: "merged" });
      expect(workspace.calls).not.toContain(`createWorktree:${BRANCH}`);
      expect(runner.requests[0]?.cwd).toBe(worktree);
    });

    describe("that has parted from the remote branch", () => {
      beforeEach(() => {
        recorded();
        leftover();
        workspace.partedBranches.add(BRANCH);
      });

      it("hands the Ticket off at setup, saying the two have parted", async () => {
        const outcome = await run();

        expect(outcome).toMatchObject({ outcome: "handed-off", stage: "setup" });
        expect(handoffBody()).toContain(
          `the worktree at ${worktree} and the branch ${BRANCH} on the remote have parted`,
        );
        expect(handoffBody()).toContain(`worktree \`${worktree}\``);
        expect(runner.stages()).toEqual([]);
        expect(tracker.issue(TICKET).labels).toEqual(["ready-for-human"]);
      });

      it("names the branch instead when this Host kept it without its worktree", async () => {
        workspace.worktrees.delete(worktree);

        const outcome = await run();

        expect(outcome).toMatchObject({ outcome: "handed-off", stage: "setup" });
        expect(handoffBody()).toContain(
          `the branch ${BRANCH} on this Host and the branch ${BRANCH} on the remote have parted`,
        );
        expect(handoffBody()).toContain(`\`git branch -D ${BRANCH}\``);
        expect(handoffBody()).not.toContain("worktree `");
        expect(workspace.state(TICKET)).toMatchObject({ state: "implemented" });
      });

      it("pushes nothing over the remote branch and opens no draft PR", async () => {
        const outcome = await run();

        expect(outcome).not.toHaveProperty("pullRequest");
        expect(workspace.calls).not.toContain(`push:${BRANCH}`);
        expect(tracker.pullRequests).toEqual([]);
      });

      it("keeps the State, so the Ticket resumes once a human has chosen a side", async () => {
        await run();

        expect(workspace.state(TICKET)).toMatchObject({ state: "implemented" });

        // The human keeps the remote's work and throws this Host's away.
        workspace.worktrees.delete(worktree);
        workspace.branches.delete(BRANCH);
        workspace.partedBranches.delete(BRANCH);
        tracker.issue(TICKET).labels = ["ready-for-agent"];
        const outcome = await run();

        expect(outcome).toMatchObject({ outcome: "merged" });
        expect(runner.stages()).toEqual(["verify"]);
      });
    });
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
    expect(workspace.states.has(TICKET)).toBe(false);
    expect(handoffBody()).not.toContain("after the fix budget was used");
  });

  it("reaches the same hand-off when a released Ticket's worktree has gone", async () => {
    workspace.recordState({
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
    expect(workspace.states.has(TICKET)).toBe(false);
  });

  it("names the worktree instead when the branch is still checked out in one", async () => {
    // A branch of the Ticket's name checked out in its worktree with nothing
    // recorded beside it: a human's work, since a Ticket the pipeline handed
    // off keeps its State file and resumes without ever reaching here.
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
    // The worktree is on disk here, so the hand-off still sends the human to it.
    expect(handoffBody()).toContain(`worktree \`${worktree}\``);
    // And the State file the Claim wrote goes, alone among hand-offs: no Stage
    // of this Run ran in there, so a later resume would implement over a human.
    expect(workspace.states.has(TICKET)).toBe(false);
  });

  it("pushes nothing and opens no draft PR over the worktree it names", async () => {
    workspace.worktrees.set(worktree, BRANCH);

    const outcome = await run();

    // No Stage of this Run ran in there: what the branch carries is a human's
    // work, which the pipeline neither writes to the remote nor presents as
    // this Run's in a PR that says `Closes #<n>`.
    expect(outcome).not.toHaveProperty("pullRequest");
    expect(workspace.calls).not.toContain(`push:${BRANCH}`);
    expect(tracker.pullRequests).toEqual([]);
    expect(handoffBody()).toContain(`Branch \`${BRANCH}\``);
    expect(handoffBody()).not.toContain("PR #");
  });

  it("says nothing about a draft PR it never set out to open", async () => {
    workspace.worktrees.set(worktree, BRANCH);

    const outcome = await run();

    // The line a failed attempt logs reads as if something had gone wrong.
    expect(logged.some((line) => line.includes("could not open a draft PR"))).toBe(false);
    // What the Run log says instead is the refusal, exactly as it always did.
    if (outcome.outcome !== "handed-off") throw new Error("the Ticket was not handed off");
    expect(logged).toContain(`#${TICKET} handed off at setup · ${outcome.failure}`);
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
    workspace.rebaseOutcome = { ok: false, conflict: CONFLICT };
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

/**
 * A hand-off and the relabel that answers it, in one test: the second `run()` is
 * the next Run meeting a Ticket a human has handed back by moving the label to
 * `ready-for-agent`. What the hand-off left — the branch, the worktree, the
 * draft pull request and the State file — is what that Run picks up.
 */
describe("a Ticket handed off and then handed back", () => {
  /** Every Stage both Runs asked for, so the second Run's shortcuts are visible. */
  const stages = () => runner.stages();

  /** Every progress table on the Ticket, oldest first. */
  const tables = () =>
    tracker
      .issue(TICKET)
      .comments.filter(({ body }) => body.startsWith(PROGRESS_MARKER))
      .map(({ body }) => body);

  /** A first Run that spends the Fix budget and is handed off at the Checks. */
  async function handedOff(): Promise<void> {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "checks" });
  }

  /** The relabel a human does, which is the whole of handing a Ticket back. */
  function handedBack(): void {
    tracker.issue(TICKET).labels = ["ready-for-agent"];
  }

  it("keeps the branch, the worktree, the draft PR and the State file", async () => {
    await handedOff();

    expect(workspace.worktrees.get(worktree)).toBe(BRANCH);
    expect(tracker.pullRequest(100).draft).toBe(true);
    expect(workspace.state(TICKET)).toMatchObject({
      state: "implemented",
      branch: BRANCH,
      pullRequest: 100,
      fixUsed: false,
    });
  });

  it("is inert until a human relabels it: naming it by hand is refused", async () => {
    await handedOff();

    // `ready-for-human` is not `ready-for-agent`, and the sweep cannot see it
    // either, the Claim having come off. Nothing moves until the human does.
    expect(await run()).toMatchObject({ outcome: "skipped", reason: "not-ready" });
    expect(workspace.states.has(TICKET)).toBe(true);
  });

  it("resumes from what it reached rather than implementing a second time", async () => {
    await handedOff();
    handedBack();

    expect(await run()).toMatchObject({ outcome: "merged", pullRequest: 100 });
    // One implement Stage across both Runs, which is the whole of what this
    // saves, and the one worktree the first Run made.
    expect(stages()).toEqual(["implement", "fix", "verify"]);
    expect(workspace.calls.filter((call) => call === `createWorktree:${BRANCH}`)).toHaveLength(1);
  });

  it("takes the pull request out of draft before it waits for CI", async () => {
    await handedOff();
    handedBack();

    await run();

    // A draft pull request often runs no workflows at all, so waiting first
    // would read as "no checks" and end the Ticket short of the merge.
    expect(tracker.pullRequest(100).draft).toBe(false);
    expect(tracker.calls.indexOf("markPullRequestReady:100")).toBeLessThan(
      tracker.calls.indexOf("waitForCi:100"),
    );
    expect(tracker.pullRequests).toHaveLength(1);
  });

  it("hands the Ticket off again when the pull request cannot be taken out of draft", async () => {
    await handedOff();
    handedBack();
    tracker.markPullRequestReady = async () => {
      throw new Error("gh: pull request is closed");
    };

    // Closing the pull request said the work was not to be continued, so the
    // failure is the answer rather than something to work around.
    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "pr" });
  });

  it("buys a fresh fix Stage, the Ticket having been through a human's hands", async () => {
    await handedOff();
    handedBack();
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(stages()).toEqual(["implement", "fix", "fix", "verify"]);
  });

  it("posts a progress comment of its own, leaving the one the human read", async () => {
    await handedOff();
    const [handed] = tables();
    handedBack();

    await run();

    expect(tables()).toEqual([handed, expect.stringContaining("| merge | ✅ #100 |")]);
  });

  it("marks the hand-off it is answering as history", async () => {
    await handedOff();
    handedBack();

    await run();

    const handoffs = tracker
      .issue(TICKET)
      .comments.filter(({ body }) => body.startsWith(HANDOFF_MARKER));
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.body).toContain(HANDOFF_TAKEN_LINE);
  });

  it("edits the newest table, not the oldest, once the Ticket carries two", async () => {
    await handedOff();
    handedBack();
    // A second Run that gets as far as verify and is then released, so a third
    // Run resumes a Ticket carrying two tables and a hand-off already history.
    runner.queue("verify", { ok: false, failure: "rate-limited" });
    expect(await run()).toMatchObject({ outcome: "released" });
    const [handed] = tables();

    expect(await run()).toMatchObject({ outcome: "merged" });

    expect(tables()).toEqual([handed, expect.stringContaining("| merge | ✅ #100 |")]);
  });

  it("clears the State file once the Ticket it took back merges", async () => {
    await handedOff();
    handedBack();

    await run();

    expect(workspace.states.has(TICKET)).toBe(false);
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

describe("a hand-off the Ticket was already carrying", () => {
  /** What the Run that handed the Ticket to a human left on it. */
  const EARLIER = handoffComment({
    stage: "verify",
    failure: "1 criterion unmet",
    branch: BRANCH,
    worktree: "/repo/.worktrees/ticket-2",
    evidence: "docs updated — nothing written",
  });

  /** A hand-off comment already on the Ticket when this Run claims it. */
  function carrying(id: string): void {
    tracker.issue(TICKET).comments.push({ id, body: EARLIER });
  }

  function onTicket(): string[] {
    return tracker.issue(TICKET).comments.map(({ body }) => body);
  }

  it("marks it as history at the Claim, keeping the failure and the evidence", async () => {
    carrying("c9");

    await run();

    const [marked = ""] = onTicket();
    expect(marked.split("\n").slice(0, 2)).toEqual([HANDOFF_MARKER, HANDOFF_TAKEN_LINE]);
    expect(marked).toContain("- Failure: 1 criterion unmet");
    expect(marked).toContain("worktree `/repo/.worktrees/ticket-2`");
    expect(marked).toContain("docs updated — nothing written");
  });

  it("marks it before the first Stage runs, so no Stage reads it as current", async () => {
    carrying("c9");
    const seen: string[][] = [];
    const runStage = runner.run.bind(runner);
    runner.run = async (request) => {
      seen.push(onTicket());
      return runStage(request);
    };

    await run();

    expect(seen[0]?.[0]).toContain(HANDOFF_TAKEN_LINE);
  });

  it("marks every hand-off on the Ticket, not only the newest", async () => {
    carrying("c8");
    carrying("c9");

    await run();

    expect(onTicket().filter((body) => body.includes(HANDOFF_TAKEN_LINE))).toHaveLength(2);
  });

  it("leaves the hand-off this Run posts reading as the current one", async () => {
    carrying("c9");
    workspace.failCheck("npm test", "1 failing · expected true to be false");

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off" });
    const handoffs = onTicket().filter((body) => body.startsWith(HANDOFF_MARKER));
    expect(handoffs).toHaveLength(2);
    expect(handoffs[0]).toContain(HANDOFF_TAKEN_LINE);
    expect(handoffs.at(-1)).not.toContain(HANDOFF_TAKEN_LINE);
  });

  it("writes nothing extra to a Ticket that was never handed off", async () => {
    await run();

    expect(tracker.updatedComments.every(({ body }) => body.startsWith(PROGRESS_MARKER))).toBe(
      true,
    );
  });

  it("logs an edit the tracker refuses and merges the Ticket anyway", async () => {
    carrying("c9");
    const update = tracker.updateComment.bind(tracker);
    tracker.updateComment = async (id, body) => {
      if (id === "c9") throw new Error("comment is locked");
      await update(id, body);
    };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(logged).toContainEqual(
      `#${TICKET} could not mark a hand-off comment as history: comment is locked`,
    );
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
  /** A passing Verdict with Notes beside it, as a verify session emits one. */
  const verdictWithNotes = (notes: unknown[]) =>
    stageResult({ result: { ...PASSING_VERDICT, notes } });

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

  it("comments a Note that names no Ticket on the standing Notes issue", async () => {
    runner.queue("implement", noteResult([{ note: "Nothing cleans up worktrees." }]));

    await run();

    expect(tracker.createdIssues).toHaveLength(1);
    expect(tracker.createdIssues[0]).toMatchObject({
      title: "Notes from the pipeline",
      labels: ["needs-triage"],
    });
    expect(tracker.createdIssues[0]?.body).toContain("<!-- agent-pipeline:notes-issue -->");
    expect(tracker.comments).toContainEqual({
      issue: 200,
      body: "<!-- agent-pipeline:note -->\nFrom #2 implement\n\nNothing cleans up worktrees.\n",
    });
  });

  it("tells the implement Stage which issue Notes are gathered on", async () => {
    tracker.addIssue({
      number: 50,
      title: "Notes from the pipeline",
      body: "<!-- agent-pipeline:notes-issue -->\n**Notes from the pipeline.**\n",
      labels: ["needs-triage"],
    });

    await run();

    expect(runner.requests.find((request) => request.stage === "implement")?.prompt).toContain(
      "gathered on #50",
    );
  });

  it("tells it nothing when no standing Notes issue is open", async () => {
    await run();

    expect(runner.requests.find((request) => request.stage === "implement")?.prompt).not.toContain(
      "gathered on",
    );
  });

  it("tells the fix Stage the issue this Run's own Notes opened", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
    runner.queue("implement", noteResult([{ note: "Nothing cleans up worktrees." }]));

    await run();

    expect(runner.requests.find((request) => request.stage === "fix")?.prompt).toContain(
      "gathered on #200",
    );
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

  it("routes the verify Stage's Notes too", async () => {
    runner.queue("verify", verdictWithNotes([{ ticket: OTHER, note: "found while grading" }]));

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "merged",
      notes: [{ origin: TICKET, stage: "verify", issue: OTHER, note: "found while grading" }],
    });
  });

  it("sends a verify Note naming the Ticket it is grading to triage", async () => {
    runner.queue(
      "verify",
      verdictWithNotes([{ ticket: TICKET, note: "the lock file is never read" }]),
    );

    const outcome = await run();

    expect(outcome).toMatchObject({
      notes: [{ origin: TICKET, stage: "verify", issue: 200, opened: true }],
    });
    expect(tracker.issue(TICKET).comments.map(({ body }) => body)).not.toContainEqual(
      expect.stringContaining("the lock file is never read"),
    );
  });

  it("routes a failed verify Stage's Notes before handing the Ticket off", async () => {
    runner.queue("verify", {
      ...verdictWithNotes([{ ticket: OTHER, note: "noticed before I ran out of turns" }]),
      ok: false,
      failure: "turn-capped",
    });

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "handed-off",
      stage: "verify",
      notes: [{ stage: "verify", issue: OTHER, note: "noticed before I ran out of turns" }],
    });
  });

  it("routes the Notes of a verify Stage whose Verdict was unusable", async () => {
    runner.queue(
      "verify",
      stageResult({ result: { notes: [{ ticket: OTHER, note: "graded nothing, saw this" }] } }),
    );

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "handed-off",
      stage: "verify",
      notes: [{ stage: "verify", issue: OTHER, note: "graded nothing, saw this" }],
    });
  });

  it("routes a verify Note before the worktree it was found in is cleaned", async () => {
    workspace.discardChanges = async () => {
      throw new Error("git: unable to unlink");
    };
    runner.queue("verify", verdictWithNotes([{ ticket: OTHER, note: "noticed while grading" }]));

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "handed-off",
      notes: [{ stage: "verify", issue: OTHER, note: "noticed while grading" }],
    });
  });

  it("merges the Ticket anyway when a verify Note reaches nowhere at all", async () => {
    tracker.createIssue = async () => {
      throw new Error("gh: connection reset");
    };
    runner.queue("verify", verdictWithNotes([{ note: "lost" }]));

    expect(await run()).toMatchObject({ outcome: "merged", notes: [] });
  });

  it("tells the verify Stage which issue Notes are gathered on", async () => {
    tracker.addIssue({
      number: 50,
      title: "Notes from the pipeline",
      body: "<!-- agent-pipeline:notes-issue -->\n**Notes from the pipeline.**\n",
      labels: ["needs-triage"],
    });

    await run();

    expect(runner.requests.find((request) => request.stage === "verify")?.prompt).toContain(
      "gathered on #50",
    );
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

  it("opens one standing issue for the Notes of both its Stages", async () => {
    workspace.failCheckOnce("npm test", "FAIL src/a.test.ts");
    runner.queue("implement", noteResult([{ note: "worktrees leak" }]));
    runner.queue("fix", noteResult([{ note: "so does the lock file" }]));

    const outcome = await run();

    expect(tracker.createdIssues).toHaveLength(1);
    expect(outcome).toMatchObject({
      notes: [
        { stage: "implement", issue: 200, opened: true },
        { stage: "fix", issue: 200, opened: false },
      ],
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

describe("the Landing", () => {
  const SECOND = 3;
  const SECOND_BRANCH = "agent/3-the-second-ticket";

  /** One Run's Pipeline, which every Ticket driven through it shares. */
  let shared: Pipeline;

  beforeEach(async () => {
    tracker.addIssue({ number: SECOND, title: "The second Ticket" });
    const settings = config();
    shared = {
      tracker,
      runner,
      workspace,
      config: settings,
      repoRoot,
      runId: "run-1",
      version: VERSION,
      host: "workstation",
      baseBranch: await resolveBaseBranch(tracker, settings),
      landing: new Landing(),
      standingNotes: new StandingNotes(),
      log: (line) => logged.push(line),
    };
  });

  /** One Ticket through the shared Pipeline, started rather than waited for. */
  const land = (ticket: number) => processTicket(shared, ticket);

  /** How many Tickets have reached the rebase, which is the Landing's door. */
  const rebases = () => workspace.calls.filter((call) => call === "rebase").length;

  /**
   * The Landing's pulls and rebases, in the order the Tickets went through
   * them: the pull at its door, the rebase, and the pull after the merge.
   */
  const landings = () =>
    workspace.calls.filter((call) => call === "rebase" || call === "pullBase");

  /**
   * Which branch a pull request was opened or updated from when, which is one
   * Ticket per turn at the Landing. The pushes a committing Stage makes happen
   * outside it, so they are not counted.
   */
  const pushed = () =>
    tracker.calls.flatMap((call) => {
      const published = /^(?:createPullRequest|updatePullRequestBody):(\d+)/.exec(call);
      return published ? [tracker.pullRequest(Number(published[1])).head] : [];
    });

  it("holds the second Ticket's rebase until the first has merged and pulled", async () => {
    workspace.conflictOnce(CONFLICT);
    const conflict = runner.holds("conflict");
    const first = land(TICKET);
    const second = land(SECOND);
    await conflict.started();
    await settle();

    // One Ticket is stopped in its conflict Stage, inside the Landing; the
    // other has done everything it may do outside one.
    expect(rebases()).toBe(1);

    conflict.release();
    await Promise.all([first, second]);

    expect(landings()).toEqual([
      "pullBase",
      "rebase",
      "pullBase",
      "pullBase",
      "rebase",
      "pullBase",
    ]);
  });

  it("holds the second Ticket's rebase while the first waits for CI", async () => {
    const ci = tracker.holdsCi();
    const first = land(TICKET);
    const second = land(SECOND);
    await ci.started();
    await settle();

    expect(rebases()).toBe(1);
    expect(tracker.ciWaits).toHaveLength(1);

    ci.release();
    await Promise.all([first, second]);

    expect(landings()).toEqual([
      "pullBase",
      "rebase",
      "pullBase",
      "pullBase",
      "rebase",
      "pullBase",
    ]);
  });

  it("lands the Ticket that reached the rebase first, whatever its number", async () => {
    const ci = tracker.holdsCi();
    // The higher number arrives on its own: the lower one has not been started
    // by the time this one is inside the Landing.
    const first = land(SECOND);
    await ci.started();
    const second = land(TICKET);
    await settle();

    // Waiting at the door behind a Ticket with a higher number: the queue is
    // the order they arrived in and nothing else.
    expect(rebases()).toBe(1);

    ci.release();
    await Promise.all([first, second]);

    expect(pushed()).toEqual([SECOND_BRANCH, BRANCH]);
  });

  it("gives the Landing up for a fix Stage, so another Ticket lands meanwhile", async () => {
    tracker.queueCi({ state: "failed", summary: "checks/build failed", excerpt: "" });
    const fix = runner.holds("fix");
    const first = land(TICKET);
    await fix.started();

    // Nobody is waiting on a fix session, so the Ticket that arrives while one
    // is open rebases, merges and pulls without ever meeting it.
    expect(await land(SECOND)).toMatchObject({ outcome: "merged" });

    fix.release();

    expect(await first).toMatchObject({ outcome: "merged" });
    expect(pushed()).toEqual([BRANCH, SECOND_BRANCH, BRANCH]);
  });

  it("sends a Ticket back to the end of the queue after its fix Stage", async () => {
    tracker.queueCi({ state: "failed", summary: "checks/build failed", excerpt: "" });
    const fix = runner.holds("fix");
    const first = land(TICKET);
    await fix.started();

    // Arrived while the first Ticket was out of the Landing, and holds it from
    // its own rebase until its own pull.
    const ci = tracker.holdsCi();
    const second = land(SECOND);
    await ci.started();

    fix.release();
    await settle();

    // The mended Ticket is at the rebase again and waiting there: re-entering
    // is joining the queue, not taking the turn it gave up back.
    expect(rebases()).toBe(2);

    ci.release();
    await Promise.all([first, second]);

    expect(pushed()).toEqual([BRANCH, SECOND_BRANCH, BRANCH]);
  });

  it("gives the Landing up when a Ticket is handed off from inside it", async () => {
    tracker.queueCi({ state: "timed-out" });
    const ci = tracker.holdsCi();
    const first = land(TICKET);
    await ci.started();
    const second = land(SECOND);
    await settle();

    expect(rebases()).toBe(1);

    ci.release();

    expect(await first).toMatchObject({ outcome: "handed-off", stage: "ci" });
    expect(await second).toMatchObject({ outcome: "merged" });
  });

  it("gives the Landing up when a Ticket is released from inside it", async () => {
    workspace.conflictOnce(CONFLICT);
    workspace.rebaseStateAfterStage = UNRESOLVED;
    runner.queue("conflict", { ok: false, failure: "rate-limited" });
    const conflict = runner.holds("conflict");
    const first = land(TICKET);
    await conflict.started();
    const second = land(SECOND);
    await settle();

    expect(rebases()).toBe(1);

    conflict.release();

    expect(await first).toMatchObject({ outcome: "released", stage: "rebase" });
    expect(await second).toMatchObject({ outcome: "merged" });
  });
});

function handoffBody(): string {
  const comment = tracker.comments.at(-1);
  if (!comment) throw new Error("no hand-off comment was written");
  return comment.body;
}
