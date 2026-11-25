import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { UNCHECKED_BOX } from "./acceptance-criteria.js";
import { throwOnFailure } from "./adapters/exec.js";
import { resolveBaseBranch } from "./base-branch.js";
import type { Config } from "./config.js";
import { type Billing, type Credential, emptyBilling } from "./credential.js";
import { BaseBranchChecks } from "./failing-base.js";
import { Landing } from "./landing.js";
import { StandingNotes } from "./notes.js";
import { processTicket } from "./orchestrator.js";
import { OutsideFault } from "./outside-fault.js";
import { failedExecution } from "./testing/executions.js";
import { PROGRESS_MARKER, progressComment } from "./progress.js";
import { HANDOFF_MARKER, HANDOFF_TAKEN_LINE, handoffComment } from "./templates.js";
import type { Pipeline, TicketOutcome } from "./orchestrator.js";
import type { StageName } from "./ports/agent-runner.js";
import type { TicketState } from "./ports/workspace.js";
import {
  FAKE_PLUGIN_DIR,
  FakeAgentRunner,
  FakeTracker,
  FakeWorkspace,
  stageResult,
} from "./testing/fakes.js";
import { settle } from "./testing/settle.js";
import type { TranscriptHome } from "./transcript-home.js";

/** The version this Run is, as the CLI resolves it once and hands it down. */
const VERSION = "0.4.0+331d79c";

const TICKET = 2;
const BRANCH = "agent/2";
const URL = "https://github.com/acme/repo/issues/2";
const CONFLICT = "CONFLICT (content): Merge conflict in src/cli.ts";
const UNRESOLVED = { resolved: false, unresolved: "a rebase is still in progress" } as const;
/** CI gone red on the pull request, with the log a fix Stage would be handed. */
const RED_CI = { state: "failed", summary: "checks/test failed", excerpt: "FAIL src/a.test.ts" } as const;

function config(overrides: Partial<Config> = {}): Config {
  return {
    lanes: 1,
    checks: ["npm test", "npm run typecheck"],
    merge: true,
    checksNamed: false,
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

/**
 * A verdict answering the Ticket's criteria in order, by number. `text` is the
 * checkbox each answer is for, which {@link ticketReads} writes on the Ticket
 * when a test's criteria are not the default `it works`.
 */
function verdictResult(
  criteria: { text: string; status: string; evidence: string }[],
  pass = true,
  defects: { summary: string; evidence: string }[] = [],
) {
  return {
    criteria: criteria.map(({ status, evidence }, index) => ({ number: index + 1, status, evidence })),
    ...(defects.length === 0 ? {} : { defects }),
    pass,
  };
}

/** Write the Ticket's criteria as one checkbox per text, as the claim will read them. */
function ticketReads(...texts: string[]): void {
  tracker.issue(TICKET).body = texts.map((text) => `- [ ] ${text}`).join("\n");
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

/** What a code Stage answers: a title for the whole branch, and no Notes. */
const titled = (title: string) => stageResult({ result: { title, notes: [] } });

/** What a code Stage answers when it writes the pull request body, the problem and the solution too. */
const described = (
  prose: { body?: string; problem?: string; solution?: string },
  title = "feat(cli): do the whole thing",
) => stageResult({ result: { title, notes: [], ...prose } });

/** A code Stage's structured answer, with whatever it said about committing. */
const answer = (fields: { noCommitReason?: string }) => ({
  title: "fix(cli): mend the thing",
  notes: [],
  ...fields,
});

const FIX_REASON =
  "Criterion 1 cannot be met without overturning ADR-0003, which forbids the feed. A human has to decide.";

/**
 * The comments a human is notified about. The progress comment is not one of
 * them after its first Stage, which is the whole point of editing it in place.
 */
const notices = () => tracker.comments.filter(({ body }) => !body.startsWith(PROGRESS_MARKER));

/**
 * Any Check run in the Ticket's worktree, which the pipeline runs none of,
 * leaving out those run at its merge-base to ask whether the base branch fails
 * them too.
 */
const checksOnBranch = () =>
  workspace.ranChecks.filter((check) => check.cwd === worktree).map((check) => check.command);

let tracker: FakeTracker;
let runner: FakeAgentRunner;
let workspace: FakeWorkspace;
/**
 * The repo root the Run is given; nothing under it is read or written. Under a
 * home directory, as a workstation's checkout is, so a test can tell the
 * Host's path from the one a hand-off names.
 */
const repoRoot = "/home/me/acme";
/** Where this Ticket's Stages run, under the repo root the Run was given. */
let worktree: string;
/** The same worktree as a hand-off names it, relative to the Target's checkout. */
const SHOWN_WORKTREE = `.worktrees/ticket-${TICKET}`;
/** The Run log, for the lines a Ticket is expected to print — or not to. */
let logged: string[];
/** The Stages the Run named for being billed to something other than its own. */
let billing: Billing;
/** Where the Run keeps a handed-off Ticket's transcripts: the remote, unless a test says otherwise. */
let transcriptHome: TranscriptHome;

beforeEach(() => {
  logged = [];
  billing = emptyBilling();
  transcriptHome = "remote";
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
 * The state file as it stood when each Stage started.
 *
 * The file is written as part of the claim and rewritten as the Ticket advances,
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
  credential: Credential = "subscription",
  runId = "run-1",
): Promise<TicketOutcome> {
  const settings = config(overrides);
  return await processTicket(
    {
      tracker,
      runner,
      workspace,
      config: settings,
      repoRoot,
      runId,
      version: VERSION,
      credential,
      pluginDir: FAKE_PLUGIN_DIR,
      billing,
      baseBranch: await resolveBaseBranch(tracker, settings),
      landing: new Landing(),
      standingNotes: new StandingNotes(),
      baseChecks: new BaseBranchChecks(),
      selfHosted: false,
      transcriptHome,
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
      `addLabel:${TICKET}:in-progress`,
      `assign:${TICKET}:pipeline-user`,
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

  it("opens a pull request that closes the Ticket and summarises the verdict", async () => {
    await run();
    const pr = tracker.pullRequest(100);

    expect(pr.draft).toBe(false);
    expect(pr.head).toBe(BRANCH);
    expect(pr.title).toBe("feat(cli): do the thing");
    expect(pr.body).toBe(`Closes #${TICKET}\n`);
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

  it("merges with the pull request title plus the pull request number as the subject", async () => {
    workspace.commits = ["fix(cli): stop double-counting (#2)"];

    await run();
    const pr = tracker.pullRequest(100);

    expect(pr.title).toBe("fix(cli): stop double-counting");
    expect(pr.squashCommit?.subject).toBe("fix(cli): stop double-counting (#100)");
  });

  it("takes the title the implement Stage answered over the first commit subject", async () => {
    runner.queue("implement", titled("feat(cli): do the whole thing"));

    await run();
    const pr = tracker.pullRequest(100);

    expect(pr.title).toBe("feat(cli): do the whole thing");
    expect(pr.squashCommit?.subject).toBe("feat(cli): do the whole thing (#100)");
  });

  it("takes the fix Stage's title over the implement Stage's once a gate failed", async () => {
    runner.queue("implement", titled("chore: license the pipeline under MIT"));
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));
    runner.queue("verify", stageResult({ result: PASSING_VERDICT }));
    runner.queue("fix", titled("feat: name the pipeline ticket-runner"));

    const outcome = await run();
    const pr = tracker.pullRequest(100);

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(pr.title).toBe("feat: name the pipeline ticket-runner");
    expect(pr.squashCommit?.subject).toBe("feat: name the pipeline ticket-runner (#100)");
  });

  it("retitles a pull request already open when the fix Stage's title arrives", async () => {
    runner.queue("implement", titled("chore: license the pipeline under MIT"));
    runner.queue("fix", titled("feat: name the pipeline ticket-runner"));
    tracker.queueCi({ state: "failed", summary: "checks/build failed", excerpt: "" });

    const outcome = await run();
    const pr = tracker.pullRequest(100);

    expect(outcome).toMatchObject({ outcome: "merged", pullRequest: 100 });
    expect(tracker.pullRequests).toHaveLength(1);
    expect(tracker.calls.indexOf("updatePullRequestTitle:100")).toBeGreaterThan(-1);
    expect(tracker.calls.indexOf("updatePullRequestTitle:100")).toBeLessThan(
      tracker.calls.findIndex((call) => call.startsWith("squashMerge:100")),
    );
    expect(pr.title).toBe("feat: name the pipeline ticket-runner");
    expect(pr.squashCommit?.subject).toBe("feat: name the pipeline ticket-runner (#100)");
  });

  it("keeps the title when the Notes beside it are malformed", async () => {
    runner.queue(
      "implement",
      stageResult({ result: { title: "feat(cli): do the whole thing", notes: "none" } }),
    );

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged", notes: [] });
    expect(tracker.pullRequest(100).title).toBe("feat(cli): do the whole thing");
  });

  it("keeps the implement Stage's title when the fix Stage answers none that counts", async () => {
    runner.queue("implement", titled("feat(cli): do the whole thing"));
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));
    runner.queue("verify", stageResult({ result: PASSING_VERDICT }));
    runner.queue("fix", titled("Mended the thing"));

    await run();

    expect(tracker.pullRequest(100).title).toBe("feat(cli): do the whole thing");
  });

  // A fix Stage told to answer a title for the whole branch replaced one its
  // fix left true with one that broke the Target's own rules (#334).
  it("hands the fix Stage the implement Stage's title, and keeps it when the fix Stage answers it blank", async () => {
    runner.queue("implement", titled("feat: do the whole thing"));
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));
    runner.queue("verify", stageResult({ result: PASSING_VERDICT }));
    runner.queue("fix", titled(""));
    workspace.commits = ["feat(cli): start the thing", "fix(cli): mend the thing"];

    await run();
    const pr = tracker.pullRequest(100);

    expect(runner.prompts("fix")[0]).toContain("### `title`\n\n```\nfeat: do the whole thing\n```");
    expect(pr.title).toBe("feat: do the whole thing");
    expect(pr.squashCommit?.subject).toBe("feat: do the whole thing (#100)");
  });

  it.each([
    ["a missing", { notes: [{ summary: "the help drifts" }] }],
    ["a blank", { title: " ", notes: [{ summary: "the help drifts" }] }],
    ["a non-conventional", { title: "Did the thing", notes: [{ summary: "the help drifts" }] }],
  ])("falls back to the first commit subject over %s title, and still posts the Notes", async (_, result) => {
    runner.queue("implement", stageResult({ result }));

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(tracker.pullRequest(100).title).toBe("feat(cli): do the thing");
    expect(tracker.comments.map(({ body }) => body)).toContainEqual(
      expect.stringContaining("**the help drifts**"),
    );
  });

  it("carries the branch's co-authors into the squash commit", async () => {
    workspace.coAuthorList = ["Claude Opus 5 <noreply@anthropic.com>"];

    await run();

    expect(tracker.pullRequest(100).squashCommit?.body).toContain(
      "\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>\n",
    );
  });

  it("composes a body of Closes, the problem, the solution and the unverified criteria", async () => {
    runner.queue(
      "implement",
      described({ body: "## Summary", problem: "There was no flag.", solution: "It adds one." }),
    );
    runner.queue("verify", stageResult({ result: MIXED_VERDICT }));
    ticketReads("it works", "the docs say so");

    await run();

    expect(tracker.pullRequest(100).squashCommit?.body).toBe(
      [
        `Closes #${TICKET}`,
        "",
        "There was no flag.",
        "",
        "It adds one.",
        "",
        "Unverified:",
        "- the docs say so — the docs are not readable from here",
        "",
      ].join("\n"),
    );
  });

  it("lets every branch commit stand in, in order, for a solution no Stage answered", async () => {
    workspace.commits = [
      "feat(cli): do the thing (#2)",
      "test(cli): cover the thing (#2)",
      "docs: write it down (#2)",
    ];

    await run();

    expect(tracker.pullRequest(100).squashCommit?.body).toBe(
      [
        `Closes #${TICKET}`,
        "",
        "- feat(cli): do the thing (#2)",
        "- test(cli): cover the thing (#2)",
        "- docs: write it down (#2)",
        "",
      ].join("\n"),
    );
  });

  it("carries no verdict counts, no HTML and no Run line in the commit", async () => {
    runner.queue("verify", stageResult({ result: MIXED_VERDICT }));
    ticketReads("it works", "the docs say so");

    await run();
    const commit = tracker.pullRequest(100).squashCommit;

    expect(commit?.body).not.toContain("<");
    expect(commit?.body).not.toMatch(/Verdict|met ·|Run `/);
  });

  it("writes the pull request body from the body the implement Stage answered, below Closes", async () => {
    runner.queue("implement", described({ body: "## Summary\n\nA flag." }));

    await run();

    expect(tracker.pullRequest(100).body).toBe(`Closes #${TICKET}\n\n## Summary\n\nA flag.\n`);
  });

  it("reads the branch commits after the rebase, so the merge lists what lands", async () => {
    await run();

    expect(workspace.calls.indexOf("rebase")).toBeLessThan(
      workspace.calls.lastIndexOf(`commitSubjects:${BRANCH}`),
    );
  });

  it("titles a draft pull request the hand-off opens with the title the state file holds", async () => {
    runner.queue("implement", titled("feat(cli): do the whole thing"));
    tracker.ci = RED_CI;

    const outcome = await run();

    // A human can still merge the draft, and its squash commit takes this title.
    expect(outcome).toMatchObject({ outcome: "handed-off" });
    expect(tracker.pullRequest(100).draft).toBe(true);
    expect(tracker.pullRequest(100).title).toBe("feat(cli): do the whole thing");
  });

  it("titles a draft pull request the hand-off opens with the Ticket title when the state file holds none", async () => {
    workspace.commits = [];

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off" });
    expect(tracker.pullRequest(100).draft).toBe(true);
    expect(tracker.pullRequest(100).title).toBe("Skeleton: one Ticket end to end");
  });

  it("leaves the title of a pull request that was already open when the hand-off came", async () => {
    tracker.ci = { state: "timed-out" };

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
      expect(request.logDir).toBe(`${repoRoot}/.ticket-runner/runs/run-1/${TICKET}`);
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

describe("the Check commands a Stage is told about", () => {
  /** Every Stage's prompt, from a Run that met an unmet criterion and a conflict. */
  async function everyStagePrompt(checks: string[]): Promise<string[]> {
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));
    workspace.conflictOnce(CONFLICT);
    await run({ checks });
    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify", "conflict"]);
    return runner.requests.map((request) => request.prompt);
  }

  it("are the configured ones, named to every Stage", async () => {
    for (const prompt of await everyStagePrompt(["npm test", "npm run typecheck"])) {
      expect(prompt).toContain("`npm test`, `npm run typecheck`");
    }
  });

  it("are named to no Stage where the config has none", async () => {
    for (const prompt of await everyStagePrompt([])) {
      expect(prompt).not.toMatch(/the pipeline runs its Checks|Checks passed on this commit/i);
    }
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

  it("quotes the reason an implement Stage gave for leaving no commits", async () => {
    workspace.commits = [];
    const reason = "The Ticket asks for a flag the CLI already has.";
    runner.queue("implement", stageResult({ result: answer({ noCommitReason: reason }) }));

    await run();

    expect(handoffBody()).toContain(
      "- Failure: the implement Stage left no new commits on the branch",
    );
    expect(handoffBody()).toContain(`**The implement Stage said:** ${reason}`);
  });

  it("shows no reason from an implement Stage that left no commits and did not finish", async () => {
    workspace.commits = [];
    runner.queue("implement", {
      ok: false,
      failure: "timed-out",
      result: answer({ noCommitReason: "Ran out of time." }),
    });

    await run();

    expect(handoffBody()).not.toContain("Ran out of time.");
  });

  it("shows no reason from an implement Stage that committed, in the hand-off that comes later", async () => {
    tracker.ci = RED_CI;
    runner.queue(
      "implement",
      stageResult({ result: answer({ noCommitReason: "Nothing to do here." }) }),
    );
    runner.leaves("fix", () => workspace.commits.push("fix(cli): mend the thing (#2)"));

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "ci" });
    expect(handoffBody()).not.toContain("Nothing to do here.");
  });
});

/**
 * The branch a Run claims a Ticket on, and the name the implement Stage gives
 * it once it has finished with commits, before the branch is first pushed.
 */
describe("the implement Stage names the branch", () => {
  const SLUG = "name-the-branch-at-implement";
  const NAMED = `agent/${TICKET}-${SLUG}`;

  /** What an implement Stage answers when it names the branch `slug`. */
  const naming = (slug: unknown) =>
    stageResult({ result: { title: "feat(cli): do the thing", branch: slug, notes: [] } });

  /** Every state file write, as the branch it names, in `workspace.calls` beside the git. */
  function traceStateWrites(): void {
    const writeState = workspace.writeState.bind(workspace);
    workspace.writeState = async (state) => {
      workspace.calls.push(`writeState:${state.branch}`);
      await writeState(state);
    };
  }

  /** The `keeps agent/<n>` lines the Run logged. */
  const kept = () => logged.filter((line) => line.startsWith(`#${TICKET} keeps `));

  it("claims on agent/<n>, records the new name, renames, then pushes, and agent/<n> never reaches the remote", async () => {
    runner.queue("implement", naming(SLUG));
    traceStateWrites();

    const outcome = await run();

    expect(workspace.calls).toContain(`createWorktree:agent/${TICKET}`);
    const steps = workspace.calls.filter(
      (call) => call === `writeState:${NAMED}` || call.startsWith("renameBranch:") || call.startsWith("push:"),
    );
    expect(steps.slice(0, 3)).toEqual([
      `writeState:${NAMED}`,
      `renameBranch:agent/${TICKET}:${NAMED}`,
      `push:${NAMED}`,
    ]);
    expect(workspace.calls).not.toContain(`push:agent/${TICKET}`);
    expect(workspace.remoteBranches.has(`agent/${TICKET}`)).toBe(false);
    expect(outcome).toMatchObject({ outcome: "merged", branch: NAMED });
    expect(tracker.pullRequest(100).head).toBe(NAMED);
    expect(workspace.calls.slice(-2)).toEqual([`removeWorktree:${NAMED}`, `deleteRemoteBranch:${NAMED}`]);
    expect(kept()).toEqual([]);
  });

  it("names the renamed branch in the progress comment and the hand-off written after the rename", async () => {
    runner.queue("implement", naming(SLUG));
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", branch: NAMED });
    const progress = tracker.comments.find(({ body }) => body.startsWith(PROGRESS_MARKER));
    expect(progress?.body).toContain(`\`${NAMED}\``);
    expect(progress?.body).not.toContain(`\`agent/${TICKET}\``);
    expect(tracker.pullRequest(100).head).toBe(NAMED);
    expect(handoffBody()).toContain(`Branch \`${NAMED}\``);
    expect(workspace.state(TICKET)?.branch).toBe(NAMED);
  });

  it("logs the implemented line naming the branch after the rename, and a claim that names none", async () => {
    runner.queue("implement", naming(SLUG));

    await run();

    expect(logged).toContain(`#${TICKET} claimed`);
    expect(logged).toContain(`#${TICKET} implemented · ${NAMED}`);
    expect(logged.indexOf(`#${TICKET} implemented · ${NAMED}`)).toBeLessThan(
      logged.findIndex((line) => line.startsWith(`#${TICKET} verified`)),
    );
  });

  it("keeps agent/<n> in silence when the slug is empty, and still says it implemented", async () => {
    runner.queue("implement", naming(""));

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged", branch: BRANCH });
    expect(workspace.calls.some((call) => call.startsWith("renameBranch:"))).toBe(false);
    expect(kept()).toEqual([]);
    expect(logged).toContain(`#${TICKET} implemented · ${BRANCH}`);
  });

  it.each([
    ["uppercase", "Name-The-Branch"],
    ["Hangul", "알림-설정-화면"],
    ["more than 40 characters", `${"a".repeat(20)}-${"b".repeat(20)}`],
  ])("keeps agent/<n>, and says so, when the slug is out of shape: %s", async (_why, slug) => {
    runner.queue("implement", naming(slug));

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged", branch: BRANCH });
    expect(kept()).toEqual([`#${TICKET} keeps ${BRANCH} · the slug \`${slug}\` is out of shape`]);
    expect(workspace.calls.some((call) => call.startsWith("renameBranch:"))).toBe(false);
  });

  it("keeps agent/<n>, and says so, when the state file will not take the new name", async () => {
    runner.queue("implement", naming(SLUG));
    runner.leaves("implement", () => {
      workspace.stateWriteFailure = new Error("remote rejected the state branch");
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged", branch: BRANCH });
    expect(kept()).toEqual([
      `#${TICKET} keeps ${BRANCH} · the state file could not record ${NAMED}: remote rejected the state branch`,
    ]);
    expect(workspace.calls.some((call) => call.startsWith("renameBranch:"))).toBe(false);
    expect(workspace.pushes.map((push) => push.branch)).toContain(BRANCH);
  });

  it("keeps agent/<n>, and says so, when a branch of the new name is on this Host", async () => {
    runner.queue("implement", naming(SLUG));
    workspace.branches.add(NAMED);

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged", branch: BRANCH });
    expect(kept()).toEqual([`#${TICKET} keeps ${BRANCH} · ${NAMED} is already on this Host`]);
    expect(workspace.calls.some((call) => call.startsWith("renameBranch:"))).toBe(false);
  });

  it("keeps agent/<n>, and says so, when a branch of the new name is on the remote", async () => {
    runner.queue("implement", naming(SLUG));
    workspace.remoteBranches.add(NAMED);

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged", branch: BRANCH });
    expect(kept()).toEqual([`#${TICKET} keeps ${BRANCH} · ${NAMED} is already on the remote`]);
  });

  it("keeps agent/<n>, and says so, when an implement Stage that did not finish already pushed it", async () => {
    runner.queue("implement", { ...naming(SLUG), ok: false, failure: "rate-limited" });
    runner.queue("implement", naming(SLUG));

    expect(await run()).toMatchObject({ outcome: "released", stage: "implement" });
    expect(workspace.remoteBranches.has(BRANCH)).toBe(true);
    expect(await run()).toMatchObject({ outcome: "merged", branch: BRANCH });

    expect(kept()).toEqual([`#${TICKET} keeps ${BRANCH} · ${BRANCH} is already on the remote`]);
    expect(logged).toContain(`#${TICKET} resumed from claimed`);
  });

  it("pushes an unfinished implement Stage's commits on agent/<n>, renames nothing and says nothing implemented", async () => {
    runner.queue("implement", { ...naming(SLUG), ok: false, failure: "nonzero-exit" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "implement", branch: BRANCH });
    expect(workspace.pushes.map((push) => push.branch)[0]).toBe(BRANCH);
    expect(workspace.calls.some((call) => call.startsWith("renameBranch:"))).toBe(false);
    expect(logged.some((line) => line.includes("implemented ·"))).toBe(false);
    expect(workspace.state(TICKET)?.branch).toBe(BRANCH);
  });

  it("keeps a branch a state file recorded other than agent/<n>, whatever slug the Stage answers", async () => {
    const earlier = "agent/2-what-an-earlier-version-cut-from-the-title";
    workspace.worktrees.set(worktree, earlier);
    workspace.branches.add(earlier);
    workspace.recordState({
      ticket: TICKET,
      branch: earlier,
      state: "claimed",
      fixUsed: false,
      runId: "run-0",
      updatedAt: "2026-09-17T09:00:00.000Z",
    });
    runner.queue("implement", naming(SLUG));

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged", branch: earlier });
    expect(workspace.calls.some((call) => call.startsWith("renameBranch:"))).toBe(false);
    expect(kept()).toEqual([]);
    expect(logged).toContain(`#${TICKET} implemented · ${earlier}`);
  });

  it("names the branch after resuming from implemented, as the state file recorded it", async () => {
    workspace.worktrees.set(worktree, NAMED);
    workspace.branches.add(NAMED);
    workspace.recordState({
      ticket: TICKET,
      branch: NAMED,
      state: "implemented",
      fixUsed: false,
      runId: "run-0",
      updatedAt: "2026-09-17T09:00:00.000Z",
    });

    await run();

    expect(logged[0]).toBe(`#${TICKET} resumed from implemented · ${NAMED}`);
  });
});

describe("Checks", () => {
  it("runs no Check on the branch after implement: verify grades it next", async () => {
    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(workspace.ranChecks).toEqual([]);
    expect(runner.stages()).toEqual(["implement", "verify"]);
  });

  it("runs no Check on the branch after a fix Stage, only at the merge-base CI's failure asks about", async () => {
    tracker.queueCi(RED_CI);

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify"]);
    expect(checksOnBranch()).toEqual([]);
    expect(workspace.ranChecks.map((check) => check.command)).toEqual(["npm test", "npm run typecheck"]);
    expect(workspace.ranChecks.every((check) => check.cwd !== worktree)).toBe(true);
  });

  it("runs no Check on the branch after a conflict Stage: the resolution goes on to the pull request", async () => {
    workspace.rebaseOutcome = { ok: false, conflict: CONFLICT };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(workspace.ranChecks).toEqual([]);
    expect(runner.stages()).toEqual(["implement", "verify", "conflict"]);
  });

  it("gives a Check at the merge-base the configured limit, not the default", async () => {
    tracker.ci = RED_CI;

    await run({ checkTimeoutMinutes: 2 });

    expect(workspace.ranChecks[0]?.timeoutMs).toBe(2 * 60_000);
    expect(workspace.ranChecks[0]?.cwd).not.toBe(worktree);
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
    // Both passes, so the fix budget runs out on the same verdict the agent
    // called a pass; the decision under test is the pipeline's, not the agent's.
    runner.queue("verify", { result: claimsToPass });
    runner.queue("verify", { result: claimsToPass });
    ticketReads("it works", "it is documented");

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
    ticketReads("it works", "it reads well");

    expect(await run()).toMatchObject({ outcome: "merged" });
  });

  it("hands off a verdict that is nothing but unverifiable criteria", async () => {
    runner.queue("verify", {
      result: verdictResult([{ text: "it reads well", status: "unverifiable", evidence: "taste" }]),
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "verify" });
    expect(handoffBody()).toMatch(/unverifiable/i);
  });

  it("hands off when the Stage returned no usable verdict", async () => {
    runner.queue("verify", { result: { nonsense: true } });

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "verify" });
  });

  it("lists the Ticket's unticked criteria by number, with the lines under each", async () => {
    tracker.issue(TICKET).body = "- [ ] it works\n  on every platform\n- [x] done already";
    tracker.issue(TICKET).comments.push({ id: "77", body: "Brief:\n\n- [ ] it is documented" });
    runner.queue(
      "verify",
      stageResult({
        result: verdictResult([
          { text: "it works", status: "met", evidence: "green" },
          { text: "it is documented", status: "met", evidence: "read it" },
        ]),
      }),
    );

    expect(await run()).toMatchObject({ outcome: "merged" });

    const prompt = runner.prompts("verify")[0] ?? "";
    expect(prompt).toContain("1. it works\n   on every platform\n2. it is documented");
    expect(prompt).not.toContain("done already");
  });

  it.each([
    ["leaves a listed number out", [{ number: 1, status: "met", evidence: "green" }], "Not answered: 2"],
    [
      "answers a number nobody listed",
      [
        { number: 1, status: "met", evidence: "green" },
        { number: 2, status: "met", evidence: "green" },
        { number: 3, status: "met", evidence: "green" },
      ],
      "Answered but not listed: 3",
    ],
  ])("hands off a verdict that %s, as one with no evidence, without a fix", async (_, criteria, evidence) => {
    ticketReads("it works", "it is documented");
    runner.queue("verify", stageResult({ result: { criteria, pass: true } }));

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "verify" });
    expect(runner.stages()).not.toContain("fix");
    expect(progressTable()).toContain("| verify | ❌ misnumbered |");
    expect(handoffBody()).toContain("the verdict's numbers are not the criteria it was given");
    expect(handoffBody()).toContain(evidence);
  });

  it("gives the hand-off a criterion as its checkbox line reads, not as the verdict wrote it", async () => {
    tracker.issue(TICKET).body = "- [ ] the table reads `a \\| b`:\n\n  | a | b |";
    const unmet = {
      criteria: [{ number: 1, status: "unmet", evidence: "it does not", text: "the table reads a | b" }],
      pass: false,
    };
    runner.queue("verify", stageResult({ result: unmet }));
    runner.queue("verify", stageResult({ result: unmet }));

    await run();

    expect(handoffBody()).toContain("- 1. the table reads `a \\| b`: — it does not");
    expect(handoffBody()).not.toContain("the table reads a | b");
  });
});

describe("a defect of the branch the verify Stage reports", () => {
  const DEFECT = { summary: "the new flag crashes on an empty file", evidence: "ran it: TypeError" };
  const withDefect = stageResult({
    result: verdictResult(
      [{ text: "it works", status: "met", evidence: "green" }],
      true,
      [DEFECT],
    ),
  });

  it("fails the verdict, every criterion met, and spends the fix budget on it", async () => {
    runner.queue("verify", withDefect);

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify"]);
    expect(progressTable()).toContain("| verify | ❌ 1 defect |");
  });

  it("hands the fix Stage the defect and its evidence", async () => {
    runner.queue("verify", withDefect);

    await run();

    const prompt = runner.prompts("fix")[0] ?? "";
    expect(prompt).toContain("the branch made 1 defect");
    expect(prompt).toContain("- Defect: the new flag crashes on an empty file — ran it: TypeError");
  });

  it("hands the retry verify the defect as it hands it the unmet criteria", async () => {
    runner.queue("verify", withDefect);

    await run();

    const retry = runner.prompts("verify")[1] ?? "";
    expect(retry).toContain("## Judged unmet before the fix");
    expect(retry).toContain("- Defect: the new flag crashes on an empty file — ran it: TypeError");
  });

  it("hands off a defect the retry verify still finds, naming it, beside an unmet criterion", async () => {
    runner.queue("verify", withDefect);
    runner.queue(
      "verify",
      stageResult({
        result: verdictResult(
          [{ text: "it works", status: "unmet", evidence: "red" }],
          false,
          [DEFECT],
        ),
      }),
    );

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "verify" });
    expect(progressTable()).toContain("| verify | ❌ 1 unmet · 1 defect |");
    expect(handoffBody()).toContain("1 of 1 criteria unmet, and the branch made 1 defect");
    expect(handoffBody()).toContain("- Defect: the new flag crashes on an empty file");
  });
});

describe("the Notes a verify Stage is shown", () => {
  it("lists the Notes this Ticket's implement and fix Stages wrote in this Run", async () => {
    runner.queue(
      "implement",
      stageResult({
        result: {
          title: "feat(cli): do the thing",
          notes: [{ summary: "the flag leaks a file handle", evidence: "lsof shows it" }],
        },
      }),
    );
    tracker.queueCi(RED_CI);
    runner.queue(
      "fix",
      stageResult({ result: { notes: [{ ticket: 9, summary: "the help drifts", impact: "users" }] } }),
    );

    await run();

    const [first = "", behindFix = ""] = runner.prompts("verify");
    expect(first).toContain("## Notes this Ticket's implement and fix Stages wrote in this Run");
    expect(first).toContain("- From the implement Stage: the flag leaks a file handle\n  evidence: lsof shows it");
    expect(behindFix).toContain("- From the implement Stage: the flag leaks a file handle\n  evidence: lsof shows it");
    expect(behindFix).toContain("- From the fix Stage, for #9: the help drifts\n  impact: users");
  });

  it("shows no Notes section when the code Stages wrote none", async () => {
    await run();

    expect(runner.prompts("verify")[0]).not.toContain("## Notes this Ticket's");
  });
});

describe("rebase", () => {
  it("rebases on main before opening the pull request", async () => {
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

  it("gives a pull that failed unexpectedly one line, and its whole output as evidence", async () => {
    // The message `throwOnFailure` built for #288's pull, as it reached the Run.
    const ssh = [
      "git@github.com: Permission denied (publickey).",
      "fatal: Could not read from remote repository.",
      "",
      "Please make sure you have the correct access rights",
      "and the repository exists.",
    ].join("\n");
    const pull = "`git pull --ff-only origin main` exited 1";
    workspace.pullBaseFailure = new Error(`${pull}\n${ssh}`);
    const evidence = ["<details><summary>Evidence</summary>", "", "```", ssh, "```"].join("\n");

    await run();

    expect(handoffBody()).toContain(`- Failure: ${pull}\n- Branch`);
    expect(handoffBody()).toContain(evidence);
    const draft = tracker.pullRequest(100);
    expect(draft.draft).toBe(true);
    expect(draft.body).toContain(`**Handed off at rebase.** ${pull}\n\n`);
    expect(draft.body).toContain(evidence);
  });

  it("gives a GitHub call with an argument of several lines one line, and only its output as evidence", async () => {
    // The `gh api` call a squash merge makes, failing: the commit message is an
    // argument with newlines in it, one of them ending as a failed command's
    // line does.
    const output = "HTTP 405: Pull Request is not mergeable (https://api.github.com/repos/o/r/pulls/100/merge)";
    const args = [
      "api",
      "--method",
      "PUT",
      "repos/{owner}/{repo}/pulls/100/merge",
      "-f",
      "merge_method=squash",
      "-f",
      "commit_title=feat: x (#100)",
      "-f",
      "commit_message=Closes #1\n\nWhat it does.\n\nA failed push is reported as `git push` exited 128\n",
    ];
    tracker.squashMerge = async () => {
      throwOnFailure("gh", args, { exitCode: 1, stdout: "", stderr: output, output, timedOut: false });
      throw new Error("throwOnFailure did not throw");
    };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "merge" });
    const line =
      "`gh api --method PUT repos/{owner}/{repo}/pulls/100/merge -f merge_method=squash " +
      "-f commit_title=feat: x (#100) -f commit_message=Closes #1 …` exited 1";
    expect(handoffBody()).toContain(`- Failure: ${line}\n- Branch`);
    expect(handoffBody()).toContain(
      ["<details><summary>Evidence</summary>", "", "```", output, "```"].join("\n"),
    );
    expect(handoffBody()).not.toContain("What it does.");
    expect(handoffBody()).not.toContain("exited 128");
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

  it("briefs the conflict Stage, from the worktree, under its own limits", async () => {
    workspace.conflictOnce(CONFLICT);

    await run();

    const request = runner.requests.find((r) => r.stage === "conflict");
    expect(request).toMatchObject({ cwd: worktree, maxTurns: 120, maxMinutes: 30 });
    expect(request?.prompt).not.toContain("/mattpocock-skills:");
    expect(request?.prompt).toContain(URL);
    expect(request?.prompt).toContain(CONFLICT);
  });

  it("takes the resolution on to the pull request without running a Check on it", async () => {
    workspace.conflictOnce(CONFLICT);

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(workspace.ranChecks).toEqual([]);
    expect(tracker.calls).toContain("createPullRequest:100:ready");
  });

  it("spends the fix budget on work the conflict Stage left uncommitted, before the pull request opens", async () => {
    workspace.conflictOnce(CONFLICT);
    runner.leaves("conflict", () => {
      workspace.uncommitted = ["src/cli.ts.orig"];
    });
    let fixAt = -1;
    runner.leaves("fix", () => {
      fixAt = tracker.calls.length;
      workspace.uncommitted = [];
      workspace.commits.push("fix(cli): mend the thing (#2)");
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(progressTable()).toContain("| conflict | ❌ uncommitted work |");
    expect(runner.stages()).toEqual(["implement", "verify", "conflict", "fix", "verify"]);
    expect(runner.prompts("fix")[0]).toContain("src/cli.ts.orig");
    expect(fixAt).toBeGreaterThan(-1);
    expect(tracker.calls.findIndex((call) => call.startsWith("createPullRequest"))).toBeGreaterThanOrEqual(fixAt);
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

    let fixAt = -1;
    runner.leaves("fix", () => {
      fixAt = workspace.calls.length;
      workspace.commits.push("fix(cli): mend the thing (#2)");
    });

    await run();

    // The fix Stage runs after the abort, in a worktree it can commit in.
    expect(runner.stages()).toContain("fix");
    expect(workspace.calls.indexOf("abortRebase")).toBeGreaterThan(-1);
    expect(workspace.calls.indexOf("abortRebase")).toBeLessThan(fixAt);
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
    // An unmet verdict spends the budget first, so this conflict gets one Stage only.
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));
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
  it("waits for the pull request checks up to the configured timeout", async () => {
    await run({ ciTimeoutMinutes: 5 });

    expect(tracker.ciWaits).toEqual([{ pullRequest: 100, timeoutMs: 5 * 60_000, workflowsCanRun: true }]);
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

  it("merges a pull request with no checks once the wait ends, with a warning row", async () => {
    tracker.ci = { state: "none" };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(tracker.calls).toContain("squashMerge:100");
    expect(tracker.ciWaits).toEqual([expect.objectContaining({ workflowsCanRun: true })]);
    expect(progressTable()).toMatch(/^\| ci \| ⚠️ no checks \|/m);
    expect(tracker.comments.some((comment) => /handed off/i.test(comment.body))).toBe(false);
  });

  it("hands off a pull request that conflicts with the base branch as a conflict, not as no checks", async () => {
    tracker.ci = { state: "conflicting" };

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "ci" });
    expect(tracker.calls).not.toContain("squashMerge:100");
    expect(handoffBody()).toContain("the pull request conflicts with `main`");
    expect(handoffBody()).not.toMatch(/no checks/i);
    expect(progressTable()).toMatch(/\| ci \| ❌ conflicting \|/);
  });

  it("hands off when CI does not finish in time", async () => {
    tracker.ci = { state: "timed-out" };

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "ci" });
    expect(progressTable()).toMatch(/\| ci \| ❌ timed out \|/);
  });

  describe("when no workflow can run on the pull request", () => {
    const ONLY_ELSEWHERE = [
      "on:",
      "  schedule:",
      "    - cron: '0 3 * * *'",
      "  workflow_dispatch:",
      "  pull_request:",
      "    paths: ['src/**']",
    ].join("\n");

    it("answers the wait at once and merges a pull request with no checks, saying no workflow runs", async () => {
      workspace.workflows = [{ path: ".github/workflows/ci.yml", contents: ONLY_ELSEWHERE }];
      workspace.changed = ["docs/guide.md"];
      tracker.ci = { state: "none" };

      expect(await run()).toMatchObject({ outcome: "merged" });
      expect(tracker.ciWaits).toEqual([expect.objectContaining({ workflowsCanRun: false })]);
      expect(progressTable()).toMatch(/^\| ci \| ⚠️ no workflow runs \|/m);
    });

    it("does the same on a Target with no workflow file", async () => {
      workspace.workflows = [];
      tracker.ci = { state: "none" };

      expect(await run()).toMatchObject({ outcome: "merged" });
      expect(tracker.ciWaits).toEqual([expect.objectContaining({ workflowsCanRun: false })]);
      expect(progressTable()).toMatch(/^\| ci \| ⚠️ no workflow runs \|/m);
    });

    it("still grades the checks the pull request does have", async () => {
      workspace.workflows = [];
      tracker.ci = { state: "failed", summary: "status/app failed", excerpt: "" };

      expect(await run()).toMatchObject({ outcome: "handed-off", stage: "ci" });
      expect(tracker.calls).not.toContain("squashMerge:100");
    });

    it.each([
      ["a push branches filter that excludes the pull request's branch", "on:\n  push:\n    branches: [main]", ["src/a.ts"]],
      ["a pull_request branches filter that excludes the base branch", "on:\n  pull_request:\n    branches: [develop]", ["src/a.ts"]],
      ["a paths-ignore filter every changed file matches", "on:\n  pull_request:\n    paths-ignore: ['docs/**', '*.md']", ["docs/a.md", "README.md"]],
    ])("rules out a workflow by %s", async (_, contents, changed) => {
      workspace.workflows = [{ path: ".github/workflows/ci.yml", contents }];
      workspace.changed = changed;

      await run();

      expect(tracker.ciWaits).toEqual([expect.objectContaining({ workflowsCanRun: false })]);
    });

    it("reads the base branch the Run resolved and the Ticket's own branch", async () => {
      workspace.workflows = [{ path: ".github/workflows/ci.yml", contents: `on:\n  push:\n    branches: ['${BRANCH}']` }];

      await run();

      expect(tracker.ciWaits).toEqual([expect.objectContaining({ workflowsCanRun: true })]);
    });
  });

  describe("when a workflow can run on the pull request, or the reader cannot rule one out", () => {
    it.each([
      ["a pull_request with no filter", "on: pull_request", ["docs/a.md"]],
      ["a paths filter that matches a changed file", "on:\n  pull_request:\n    paths: ['docs/**']", ["docs/a.md"]],
      ["a push with no branch filter", "on: push", ["docs/a.md"]],
      ["a `**.js` pattern and a changed `src/js/app.js`", "on:\n  pull_request:\n    paths: ['**.js']", ["src/js/app.js"]],
      ["a pattern with `?`", "on:\n  pull_request:\n    paths: ['src/?.ts']", ["docs/a.md"]],
      ["a file that does not parse", "on: [pull_request", ["docs/a.md"]],
      ["an event the reader does not rule out", "on: [schedule, pull_request_target]", ["docs/a.md"]],
    ])("gives the wait its grace on %s", async (_, contents, changed) => {
      workspace.workflows = [{ path: ".github/workflows/ci.yml", contents }];
      workspace.changed = changed;
      tracker.ci = { state: "none" };

      expect(await run()).toMatchObject({ outcome: "merged" });
      expect(tracker.ciWaits).toEqual([expect.objectContaining({ workflowsCanRun: true })]);
      expect(progressTable()).toMatch(/^\| ci \| ⚠️ no checks \|/m);
    });

    it("gives it its grace when the workflow files cannot be read at all", async () => {
      workspace.workflows = [];
      workspace.workflowFiles = async () => {
        throw new Error("git ls-tree failed");
      };

      await run();

      expect(tracker.ciWaits).toEqual([expect.objectContaining({ workflowsCanRun: true })]);
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

  it("blames the pull request step when the push fails", async () => {
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

  it("opens a draft pull request, comments, relabels and unassigns", async () => {
    await run();

    expect(tracker.pullRequest(100).draft).toBe(true);
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-human"]);
    expect(tracker.issue(TICKET).assignees).toEqual([]);
    expect(handoffBody()).toContain(`Branch \`${BRANCH}\``);
    // Relative to the Target's checkout, so the comment publishes no Host path.
    expect(handoffBody()).toContain(`worktree \`${SHOWN_WORKTREE}\``);
    expect(handoffBody()).not.toContain(repoRoot);
    expect(handoffBody()).toContain("PR #100 (draft)");
  });

  it("keeps the worktree and the branch for a human to pick up", async () => {
    await run();

    expect(workspace.worktrees.get(worktree)).toBe(BRANCH);
    expect(workspace.calls).not.toContain(`removeWorktree:${BRANCH}`);
  });

  it("converts the existing pull request to a draft rather than opening a second one", async () => {
    workspace.commits = ["feat(cli): do the thing (#2)"];
    tracker.ci = { state: "failed", summary: "checks/build failed", excerpt: "" };

    await run();

    expect(tracker.pullRequests).toHaveLength(1);
    expect(tracker.pullRequest(100).draft).toBe(true);
    expect(tracker.calls).toContain("convertPullRequestToDraft:100");
  });

  it("still relabels when the draft pull request cannot be opened", async () => {
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
  const KEPT = "- Transcripts: `ticket-2/run-1/` on the `ticket-runner/state` branch";

  it("keeps this Run's beside the state, and the comment says where they and the branch are", async () => {
    tracker.ci = RED_CI;

    expect(await run()).toMatchObject({ outcome: "handed-off" });
    expect(workspace.transcripts.get(TICKET)).toEqual(["run-1"]);
    expect(workspace.state(TICKET)).toBeDefined();
    expect(handoffBody()).toContain(`- Branch \`${BRANCH}\` on the remote · worktree`);
    expect(handoffBody()).toContain(KEPT);
  });

  it("keeps them after the rest of the hand-off is written, so the kept state is current", async () => {
    tracker.ci = RED_CI;
    let stateWhenKept: TicketState | undefined;
    const keep = workspace.keepTranscripts.bind(workspace);
    workspace.keepTranscripts = async (ticket, runId) => {
      stateWhenKept = workspace.state(ticket);
      return keep(ticket, runId);
    };

    await run();

    // The draft pull request is part of the state; transcripts kept before it
    // would sit beside a state a resuming Run opens a second pull request over.
    expect(stateWhenKept).toMatchObject({ pullRequest: 100 });
  });

  it("names them in the draft pull request's body too, and not the directory on this Host", async () => {
    tracker.ci = RED_CI;

    await run({});

    const body = tracker.pullRequest(100).body;
    expect(tracker.pullRequest(100).draft).toBe(true);
    expect(body).toContain(
      "Run `run-1` · transcripts in `ticket-2/run-1/` on the `ticket-runner/state` branch",
    );
    expect(body).not.toContain(".ticket-runner/runs/");
  });

  it("names none in the draft pull request's body when the remote will not take them", async () => {
    tracker.ci = RED_CI;
    workspace.keepTranscripts = async () => {
      throw new Error("remote rejected");
    };

    await run();

    const body = tracker.pullRequest(100).body;
    expect(body.endsWith("evidence.\n\nRun `run-1`\n")).toBe(true);
    expect(body).not.toContain("transcripts");
  });

  it("names them in a pull request that was open before the hand-off made it a draft", async () => {
    tracker.ci = { state: "failed", summary: "checks/build failed", excerpt: "" };

    await run();

    const body = tracker.pullRequest(100).body;
    expect(tracker.calls).toContain("convertPullRequestToDraft:100");
    expect(body).toContain("**Handed off at ci.**");
    expect(body).toContain(
      "Run `run-1` · transcripts in `ticket-2/run-1/` on the `ticket-runner/state` branch",
    );
    expect(body).not.toContain(".ticket-runner/runs/");
  });

  it("names none in a pull request made a draft when the remote will not take them", async () => {
    tracker.ci = { state: "failed", summary: "checks/build failed", excerpt: "" };
    workspace.keepTranscripts = async () => {
      throw new Error("remote rejected");
    };

    await run();

    const body = tracker.pullRequest(100).body;
    expect(body.endsWith("evidence.\n\nRun `run-1`\n")).toBe(true);
    expect(body).not.toContain("transcripts");
  });

  it("still hands the Ticket off when the draft pull request's body cannot be rewritten", async () => {
    tracker.ci = RED_CI;
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
    tracker.queueCi(RED_CI);
    tracker.queueCi(RED_CI);
    expect(await run()).toMatchObject({ outcome: "handed-off" });
    expect(workspace.transcripts.has(TICKET)).toBe(true);
    tracker.issue(TICKET).labels = ["ready-for-agent"];

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(workspace.transcripts.has(TICKET)).toBe(false);
    // The merge took what the draft's body pointed at, so the body goes too.
    expect(tracker.pullRequest(100).body).not.toContain("ticket-runner/state");
  });

  it("keeps none for a released Ticket, which nobody has to look into", async () => {
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    expect(await run()).toMatchObject({ outcome: "released" });
    expect(workspace.transcripts.has(TICKET)).toBe(false);
  });

  it("keeps none where the hand-off leaves no state, and says the branch is only here", async () => {
    // A branch in the way at setup: no Stage of this Run ran, and the branch
    // is a human's, which never went to the remote.
    workspace.branches.add(BRANCH);

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "setup" });
    expect(workspace.transcripts.has(TICKET)).toBe(false);
    expect(handoffBody()).not.toContain("Transcripts");
    expect(handoffBody()).toContain(`- Branch \`${BRANCH}\`\n`);
  });

  it("still hands the Ticket off, naming none, when the remote will not take them", async () => {
    tracker.ci = RED_CI;
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

  it("pushes once the implement Stage has committed, before verify grades it", async () => {
    const pushed = pushesAfter();

    await run();

    // Pushed before any other Stage ran, so before verify.
    expect(pushed[0]).toBe("implement");
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

  it("pushes once the fix Stage has committed, before verify grades it again", async () => {
    const pushed = pushesAfter();
    tracker.queueCi(RED_CI);

    await run();

    // Pushed before any other Stage ran after it, so before the verify behind it.
    expect(pushed).toContain("fix");
  });

  it("pushes once the conflict Stage has finished the rebase", async () => {
    const pushed = pushesAfter();
    workspace.conflictOnce(CONFLICT);

    await run();

    expect(pushed).toContain("conflict");
    const calls = workspace.calls;
    // Pushed as soon as the rebase is finished, before the pull request's commits are read.
    expect(calls.indexOf(`push:${BRANCH}`, calls.indexOf("rebaseState"))).toBeLessThan(
      calls.indexOf(`commitSubjects:${BRANCH}`, calls.indexOf("rebaseState")),
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

  it("retries a red CI in the same worktree and merges on the second pass", async () => {
    tracker.queueCi(RED_CI);

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify"]);
    expect(fixRequest().cwd).toBe(worktree);
    expect(workspace.calls.filter((call) => call.startsWith("createWorktree"))).toEqual([
      `createWorktree:${BRANCH}`,
    ]);
  });

  it("starts the pass it bought again at verify, running no Check on the branch", async () => {
    tracker.queueCi(RED_CI);

    await run();

    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify"]);
    expect(checksOnBranch()).toEqual([]);
  });

  it("gives the fix Stage the red CI and its log", async () => {
    tracker.queueCi(RED_CI);

    await run();

    expect(runner.prompts("fix")[0]).toMatch(/a pull request check failed/i);
    expect(runner.prompts("fix")[0]).toContain("checks/test failed");
    expect(runner.prompts("fix")[0]).toContain("FAIL src/a.test.ts");
  });

  it("retries an unmet criterion and merges on the second verdict", async () => {
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

  it("gives the verify behind it the first verdict's unmet criteria and what meeting them takes", async () => {
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));

    await run();

    const [first, second] = runner.prompts("verify");
    expect(first).not.toMatch(/judged unmet before the fix/i);
    expect(first).not.toContain("it works — npm test is red");
    expect(second).toMatch(/judged unmet before the fix/i);
    expect(second).toContain("it works — npm test is red");
    expect(second).toMatch(/counterexample is gone and the whole criterion holds/i);
  });

  it("gives the verify behind a fix for anything else no earlier verdict", async () => {
    tracker.queueCi(RED_CI);

    await run();

    expect(runner.prompts("verify")).toHaveLength(2);
    expect(runner.prompts("verify")[1]).not.toMatch(/judged unmet before the fix/i);
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

  it("merges the verdict of the pass that succeeded, not the one that failed", async () => {
    runner.queue(
      "verify",
      stageResult({
        result: verdictResult([
          { text: "it works", status: "unmet", evidence: "npm test is red" },
          { text: "the docs say so", status: "unverifiable", evidence: "not yet" },
        ]),
      }),
    );
    runner.queue("verify", stageResult({ result: MIXED_VERDICT }));
    ticketReads("it works", "the docs say so");

    await run();

    expect(tracker.pullRequest(100).squashCommit?.body).toContain(
      "Unverified:\n- the docs say so — the docs are not readable from here\n",
    );
  });

  it("hands the fix Stage the body, problem and solution answered so far", async () => {
    runner.queue(
      "implement",
      described({ body: "## Summary", problem: "There was no flag.", solution: "It adds one." }),
    );
    tracker.queueCi(RED_CI);

    await run();

    const prompt = runner.prompts("fix")[0] ?? "";
    expect(prompt).toContain("## Summary");
    expect(prompt).toContain("There was no flag.");
    expect(prompt).toContain("It adds one.");
  });

  it("keeps each answer the fix Stage left blank, and takes each one it revised", async () => {
    runner.queue(
      "implement",
      described({ body: "## Summary", problem: "There was no flag.", solution: "It adds one." }),
    );
    runner.queue("fix", described({ body: "", problem: "", solution: "It adds one, tested." }));
    tracker.queueCi(RED_CI);

    await run();

    expect(tracker.pullRequest(100).body).toBe(`Closes #${TICKET}\n\n## Summary\n`);
    expect(tracker.pullRequest(100).squashCommit?.body).toBe(
      `Closes #${TICKET}\n\nThere was no flag.\n\nIt adds one, tested.\n`,
    );
  });

  it("takes its own model, effort, turn and time limits, and its own extra prompt", async () => {
    tracker.queueCi(RED_CI);

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
    tracker.queueCi(RED_CI);

    await run();

    expect(fixRequest().jsonSchema).toBeDefined();
    expect(fixRequest().resultRequired).toBe(false);
  });

  it("logs the second pass beside the first rather than over it", async () => {
    const ticketLogs = `${repoRoot}/.ticket-runner/runs/run-1/${TICKET}`;
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));

    await run();

    // The Stage's files are named after the Stage, so the failing verdict's
    // transcript would otherwise be overwritten by the one that passed.
    expect(runner.requests.map((request) => [request.stage, request.logDir])).toEqual([
      ["implement", ticketLogs],
      ["verify", ticketLogs],
      ["fix", `${ticketLogs}/retry`],
      ["verify", `${ticketLogs}/retry`],
    ]);
  });

  it("rewrites the pull request body with the body the fix Stage answered", async () => {
    tracker.queueCi({ state: "failed", summary: "checks/build failed", excerpt: "" });
    runner.queue("implement", described({ body: "## Before the fix" }));
    runner.queue("fix", described({ body: "## After the fix" }));

    await run();

    // The body is rewritten from the latest answer, so the pull request a human
    // reads describes the branch that merges.
    expect(tracker.calls).toContain("updatePullRequestBody:100");
    expect(tracker.pullRequest(100).body).toBe(`Closes #${TICKET}\n\n## After the fix\n`);
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
    tracker.queueCi(RED_CI);

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "fix" });
    expect(handoffBody()).toContain("the fix Stage left no new commits on the branch");
    expect(handoffBody()).toContain("after the fix budget was used");
    expect(progressTable()).toContain("| fix | ❌ no commits | 7 | 1s |");
  });

  it("stops the pass there, so nothing re-grades a branch nobody touched", async () => {
    tracker.queueCi(RED_CI);

    await run();

    // The CI that bought the fix Stage was waited for once, not twice, and the
    // verdict was not asked about a branch the fix Stage left alone.
    expect(runner.stages()).toEqual(["implement", "verify", "fix"]);
    expect(tracker.ciWaits).toHaveLength(1);
  });

  it.each([
    [
      "a failed Check",
      () => {
        tracker.queueCi(RED_CI);
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

  it("hands off with the unmet criteria and their evidence it was sent in for", async () => {
    ticketReads("it reads the feed");
    runner.queue(
      "verify",
      stageResult({
        result: verdictResult([
          {
            text: "it reads the feed",
            status: "unmet",
            evidence: "ADR-0003 forbids the feed; a human decision is needed",
          },
        ]),
      }),
    );

    await run();

    expect(handoffBody()).toContain("the fix Stage left no new commits on the branch");
    expect(handoffBody()).toContain(
      "- 1. it reads the feed — ADR-0003 forbids the feed; a human decision is needed",
    );
  });

  it("quotes the reason it gave, beside the failure line and the evidence it was sent in with", async () => {
    ticketReads("it reads the feed");
    runner.queue(
      "verify",
      stageResult({
        result: verdictResult([
          {
            text: "it reads the feed",
            status: "unmet",
            evidence: "ADR-0003 forbids the feed",
          },
        ]),
      }),
    );
    runner.queue("fix", stageResult({ result: answer({ noCommitReason: FIX_REASON }) }));

    await run();

    const body = handoffBody();
    expect(body).toContain(`**The fix Stage said:** ${FIX_REASON}`);
    expect(body).toContain("- Failure: the fix Stage left no new commits on the branch");
    expect(body).toContain("- 1. it reads the feed — ADR-0003 forbids the feed");
    expect(body.indexOf("The fix Stage said")).toBeLessThan(body.indexOf("<details>"));
  });

  it("keeps the reason out of the draft pull request body", async () => {
    tracker.queueCi(RED_CI);
    runner.queue("fix", stageResult({ result: answer({ noCommitReason: FIX_REASON }) }));

    await run();

    expect(handoffBody()).toContain(FIX_REASON);
    expect(tracker.pullRequest(100).body).not.toContain(FIX_REASON);
  });

  it.each([
    ["gave no reason", answer({})],
    ["gave a blank one", answer({ noCommitReason: "  " })],
    ["answered no object at all", "I committed nothing"],
  ])("shows no reason when the Stage %s", async (_case, result) => {
    tracker.queueCi(RED_CI);
    runner.queue("fix", stageResult({ result }));

    await run();

    expect(handoffBody()).toContain("the fix Stage left no new commits on the branch");
    expect(handoffBody()).not.toContain("Stage said");
  });

  it("shows no reason from a Stage that did not finish", async () => {
    tracker.queueCi(RED_CI);
    runner.queue("fix", {
      ok: false,
      failure: "turn-capped",
      result: answer({ noCommitReason: FIX_REASON }),
    });

    await run();

    expect(handoffBody()).toContain("Failed at **fix**");
    expect(handoffBody()).not.toContain(FIX_REASON);
  });

  it("routes the Notes it made before its own outcome is judged", async () => {
    const other = 7;
    tracker.addIssue({ number: other, title: "Progress comment" });
    tracker.queueCi(RED_CI);
    runner.queue(
      "fix",
      stageResult({ result: { notes: [{ ticket: other, summary: "found while fixing" }] } }),
    );

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "handed-off",
      stage: "fix",
      notes: [{ origin: TICKET, stage: "fix", issue: other, summary: "found while fixing" }],
    });
  });

  it("is still released, not blamed, when the rate limit is why it committed nothing", async () => {
    tracker.queueCi(RED_CI);
    runner.queue("fix", { ok: false, failure: "rate-limited" });

    const outcome = await run();

    // The limit is read before the branch is: a Ticket released here spends no
    // budget, and the Run that resumes it still has the fix Stage to buy.
    expect(outcome).toMatchObject({ outcome: "released", stage: "fix" });
    expect(progressTable()).toContain("| fix | ⏸ rate limited |");
  });

  it("leaves a Stage that did commit reported as committed", async () => {
    runner.leaves("fix", () => workspace.commits.push("fix(cli): mend the thing (#2)"));
    tracker.queueCi(RED_CI);

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(progressTable()).toContain("| fix | ✅ committed | 7 | 1s |");
  });

  it("shows no reason from a Stage that committed, in the hand-off that comes later", async () => {
    runner.leaves("fix", () => workspace.commits.push("fix(cli): mend the thing (#2)"));
    tracker.ci = RED_CI;
    runner.queue("fix", stageResult({ result: answer({ noCommitReason: FIX_REASON }) }));

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "ci" });
    expect(handoffBody()).not.toContain(FIX_REASON);
    expect(handoffBody()).not.toContain("Stage said");
  });
});

describe("uncommitted work", () => {
  /** How many verify Stages had run by the time the fix Stage started. */
  let verifiesBeforeFix: number | undefined;

  beforeEach(() => {
    verifiesBeforeFix = undefined;
    // A fix Stage that commits what it found and leaves the worktree clean.
    runner.leaves("fix", () => {
      verifiesBeforeFix = runner.stages().filter((stage) => stage === "verify").length;
      workspace.commits.push("fix(cli): commit the review fixes (#2)");
      workspace.uncommitted = [];
    });
  });

  it("sends a fix Stage in with the paths before verify grades the worktree", async () => {
    runner.leaves("implement", () => {
      workspace.uncommitted = ["src/cli.ts", "src/new.test.ts"];
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["implement", "fix", "verify"]);
    expect(verifiesBeforeFix).toBe(0);
    const prompt = runner.prompts("fix")[0] as string;
    expect(prompt).toMatch(/left changes .*never committed/i);
    expect(prompt).toContain("src/cli.ts");
    expect(prompt).toContain("src/new.test.ts");
  });

  it("reads on the implement Stage's row, in place of committed", async () => {
    runner.leaves("implement", () => {
      workspace.uncommitted = ["src/cli.ts"];
    });

    await run();

    expect(progressTable()).toMatch(/\| implement \| ❌ uncommitted work \|/);
    expect(progressTable()).not.toMatch(/\| implement \| ✅ committed \|/);
    expect(progressTable()).not.toContain("| checks |");
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
    tracker.queueCi(RED_CI);
    runner.leaves("fix", () => {
      workspace.commits.push("fix(cli): mend the thing (#2)");
      workspace.uncommitted = ["src/cli.ts"];
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "fix" });
    expect(runner.stages()).toEqual(["implement", "verify", "fix"]);
    expect(progressTable()).toMatch(/\| fix \| ❌ uncommitted work \|/);
    expect(handoffBody()).toContain("the worktree holds changes no commit carries");
    expect(handoffBody()).toContain("src/cli.ts");
    expect(handoffBody()).toContain("after the fix budget was used");
    expect(workspace.uncommitted).toEqual(["src/cli.ts"]);
    expect(workspace.calls.filter((call) => call.startsWith("discardChanges"))).toHaveLength(1);
  });

  it("goes on to verify from a clean worktree, with no row of its own", async () => {
    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["implement", "verify"]);
    expect(workspace.calls).toContain(`uncommittedPaths:${worktree}`);
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
  it("is one: CI that fails twice is handed off", async () => {
    tracker.ci = RED_CI;

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "ci" });
    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify"]);
    expect(handoffBody()).toContain("after the fix budget was used");
    expect(handoffBody()).toContain("FAIL src/a.test.ts");
  });

  it("is spent by the first failure, whatever kind the second one is", async () => {
    tracker.queueCi(RED_CI);
    runner.queue("verify", stageResult({ result: PASSING_VERDICT }));
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "verify" });
    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify"]);
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
    tracker.queueCi(RED_CI);
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

  it("refuses to retry a verify Stage that returned no usable verdict", async () => {
    runner.queue("verify", { result: { nonsense: true } });

    await expectNoFix("verify");
  });

  it("refuses to retry a verify Stage that never returned", async () => {
    runner.queue("verify", { ok: false, failure: "timed-out" });

    await expectNoFix("verify");
  });

  it("refuses to retry a verdict of nothing but unverifiable criteria", async () => {
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

  it("refuses to retry a pull request that conflicts with the base branch", async () => {
    tracker.ci = { state: "conflicting" };

    await expectNoFix("ci");
  });
});

describe("releasing a rate-limited Ticket", () => {
  /** The state file the release left, as a later Run would read it. */
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
      cause: "rate-limited",
      notes: [],
    });
  });

  it("carries the time the limit resets, when the Stage said", async () => {
    runner.queue("verify", {
      ok: false,
      failure: "rate-limited",
      limitResetsAt: "2026-09-19T17:40:00.000Z",
    });

    expect(await run()).toMatchObject({
      outcome: "released",
      cause: "rate-limited",
      limitResetsAt: "2026-09-19T17:40:00.000Z",
    });
  });

  it("undoes the claim, so the next Run may pick the Ticket up", async () => {
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    await run();

    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-agent"]);
    expect(tracker.issue(TICKET).assignees).toEqual([]);
  });

  // The Run lock keeps every other Run off the board meanwhile (ADR-0008), so
  // the order only decides where a write that fails leaves the Ticket: the
  // assignee comes off before in-progress, as an assignee without it would be
  // neither claimed nor free.
  it("takes the assignee off before in-progress, so no cut leaves an assignee alone", async () => {
    runner.queue("implement", { ok: false, failure: "rate-limited" });

    await run();

    expect(tracker.calls.slice(-3)).toEqual([
      `addLabel:${TICKET}:ready-for-agent`,
      `unassign:${TICKET}:pipeline-user`,
      `removeLabel:${TICKET}:in-progress`,
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

    expect(progressTable()).toContain("| implement | ⏸ rate limited | 7 | 1s |");
  });

  it("records the implement Stage's work when the verify Stage is stopped", async () => {
    runner.queue("verify", { ok: false, failure: "rate-limited" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "released", stage: "verify" });
    expect(state()).toMatchObject({ state: "implemented", fixUsed: false });
    expect(progressTable()).toContain("| verify | ⏸ rate limited |");
  });

  it("gives back the fix budget a stopped fix Stage never spent", async () => {
    tracker.queueCi(RED_CI);
    runner.queue("fix", { ok: false, failure: "rate-limited" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "released", stage: "fix" });
    expect(state()).toMatchObject({ state: "implemented", fixUsed: false });
  });

  it("records a fix budget an earlier pass of this Run did spend", async () => {
    tracker.queueCi(RED_CI);
    runner.queue("verify", stageResult({ result: PASSING_VERDICT }));
    runner.queue("verify", { ok: false, failure: "rate-limited" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "released", stage: "verify" });
    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify"]);
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

  it("leaves a state file behind when the Ticket is handed off instead", async () => {
    runner.queue("implement", { ok: false, failure: "turn-capped" });

    // A hand-off keeps the file too; the label is what tells the two apart, and
    // a Release is not the only ending a later Run resumes from.
    expect(await run()).toMatchObject({ outcome: "handed-off" });
    expect(state()).toMatchObject({ state: "claimed", branch: BRANCH });
  });

  it("leaves no state file behind when the Ticket merges", async () => {
    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(state()).toBeUndefined();
  });
});

describe("releasing a Ticket a transient API failure stopped", () => {
  const state = () => workspace.state(TICKET);
  const apiError = { ok: false, failure: "api-error" } as const;

  it("releases the Ticket as a rate limit does, naming the API failure", async () => {
    runner.queue("implement", apiError);

    const outcome = await run();

    expect(outcome).toEqual({
      outcome: "released",
      ticket: TICKET,
      title: "Skeleton: one Ticket end to end",
      branch: BRANCH,
      stage: "implement",
      cause: "api-error",
      notes: [],
    });
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-agent"]);
    expect(tracker.issue(TICKET).assignees).toEqual([]);
    expect(notices()).toEqual([]);
    expect(tracker.pullRequests).toEqual([]);
    expect(workspace.worktrees.get(worktree)).toBe(BRANCH);
    expect(workspace.calls).not.toContain(`deleteRemoteBranch:${BRANCH}`);
    expect(state()).toMatchObject({ state: "claimed", fixUsed: false });
    expect(progressTable()).toContain("| implement | ⏸ API failure | 7 | 1s |");
  });

  it("releases a verify Stage it stopped with the implement Stage's work recorded", async () => {
    runner.queue("verify", apiError);

    expect(await run()).toMatchObject({ outcome: "released", stage: "verify", cause: "api-error" });
    expect(state()).toMatchObject({ state: "implemented", fixUsed: false });
    expect(progressTable()).toContain("| verify | ⏸ API failure |");
  });

  it("gives back the fix budget a fix Stage it stopped never spent", async () => {
    tracker.queueCi(RED_CI);
    runner.queue("fix", apiError);

    expect(await run()).toMatchObject({ outcome: "released", stage: "fix", cause: "api-error" });
    expect(state()).toMatchObject({ state: "implemented", fixUsed: false });
    expect(progressTable()).toContain("| fix | ⏸ API failure |");
  });

  it("keeps a fix budget an earlier pass of this Run spent", async () => {
    tracker.queueCi(RED_CI);
    runner.queue("verify", stageResult({ result: PASSING_VERDICT }));
    runner.queue("verify", apiError);

    expect(await run()).toMatchObject({ outcome: "released", stage: "verify" });
    expect(state()).toMatchObject({ fixUsed: true });
  });

  it("aborts the rebase a conflict Stage it stopped left behind", async () => {
    workspace.rebaseOutcome = { ok: false, conflict: CONFLICT };
    workspace.rebaseStateAfterStage = UNRESOLVED;
    runner.queue("conflict", apiError);

    expect(await run()).toMatchObject({ outcome: "released", stage: "rebase", cause: "api-error" });
    expect(runner.stages()).toEqual(["implement", "verify", "conflict"]);
    expect(workspace.aborts).toBe(1);
    expect(progressTable()).toContain("| conflict | ⏸ API failure |");
  });

  it("still hands off a Stage that ended on any other error", async () => {
    runner.queue("implement", { ok: false, failure: "nonzero-exit" });

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "implement" });
  });
});

describe("releasing a Ticket whose API key ran out of budget", () => {
  const state = () => workspace.state(TICKET);
  const outOfBudget = { ok: false, failure: "out-of-budget" } as const;

  it("releases the Ticket as a rate limit does, naming the budget", async () => {
    runner.queue("implement", outOfBudget);

    const outcome = await run({}, "api-key");

    expect(outcome).toEqual({
      outcome: "released",
      ticket: TICKET,
      title: "Skeleton: one Ticket end to end",
      branch: BRANCH,
      stage: "implement",
      cause: "out-of-budget",
      notes: [],
    });
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-agent"]);
    expect(tracker.issue(TICKET).assignees).toEqual([]);
    expect(notices()).toEqual([]);
    expect(tracker.pullRequests).toEqual([]);
    expect(workspace.worktrees.get(worktree)).toBe(BRANCH);
    expect(workspace.calls).not.toContain(`deleteRemoteBranch:${BRANCH}`);
    expect(state()).toMatchObject({ state: "claimed", fixUsed: false });
    expect(progressTable()).toContain("| implement | ⏸ out of API budget | 7 | 1s |");
    expect(logged).toContain(`#${TICKET} released at implement · out of API budget · ${BRANCH}`);
  });

  it("gives back the fix budget a fix Stage it stopped never spent", async () => {
    tracker.queueCi(RED_CI);
    runner.queue("fix", outOfBudget);

    expect(await run({}, "api-key")).toMatchObject({
      outcome: "released",
      stage: "fix",
      cause: "out-of-budget",
    });
    expect(state()).toMatchObject({ state: "implemented", fixUsed: false });
    expect(progressTable()).toContain("| fix | ⏸ out of API budget |");
  });

  it("aborts the rebase a conflict Stage it stopped left behind", async () => {
    workspace.rebaseOutcome = { ok: false, conflict: CONFLICT };
    workspace.rebaseStateAfterStage = UNRESOLVED;
    runner.queue("conflict", outOfBudget);

    expect(await run({}, "api-key")).toMatchObject({
      outcome: "released",
      stage: "rebase",
      cause: "out-of-budget",
    });
    expect(workspace.aborts).toBe(1);
    expect(progressTable()).toContain("| conflict | ⏸ out of API budget |");
  });
});

describe("the rate limit of a Run on the API key", () => {
  it("is put down to the API's rate limit, not the subscription's", async () => {
    runner.queue("verify", { ok: false, failure: "rate-limited" });

    const outcome = await run({}, "api-key");

    expect(outcome).toMatchObject({ outcome: "released", stage: "verify", cause: "rate-limited" });
    expect(progressTable()).toContain("| verify | ⏸ API rate limited |");
    expect(logged).toContain(`#${TICKET} released at verify · API rate limit · ${BRANCH}`);
  });

  it("stays the plain rate limit on a subscription Run", async () => {
    runner.queue("verify", { ok: false, failure: "rate-limited" });

    await run();

    expect(progressTable()).toContain("| verify | ⏸ rate limited |");
    expect(logged).toContain(`#${TICKET} released at verify · rate limit · ${BRANCH}`);
  });
});

describe("a Stage billed to something other than its Run's subscription or API key", () => {
  it("is named in the log and kept for the summary", async () => {
    runner.queue("verify", stageResult({ result: PASSING_VERDICT, apiKeySource: "apiKeyHelper" }));

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(billing.strays).toEqual([{ ticket: TICKET, stage: "verify", apiKeySource: "apiKeyHelper" }]);
    expect(logged).toContain(
      `#${TICKET} verify ran on apiKeySource apiKeyHelper, not the subscription (none)`,
    );
  });

  it("is a Stage on the subscription in a Run on the API key", async () => {
    runner.queue("implement", { apiKeySource: "none" });

    await run({}, "api-key");

    expect(billing.strays).toEqual([{ ticket: TICKET, stage: "implement", apiKeySource: "none" }]);
  });

  it("is never a Stage that ran on the Run's own, or said nothing", async () => {
    runner.queue("implement", { apiKeySource: "ANTHROPIC_API_KEY" });

    await run({}, "api-key");

    expect(billing.strays).toEqual([]);
    expect(logged.join("\n")).not.toContain("apiKeySource");
  });
});

describe("what a Run's Stages were billed", () => {
  const ON_KEY = "ANTHROPIC_API_KEY";

  it("adds up the figure of every Stage on an `--api-key` Run's own key, and prints none of it", async () => {
    runner.queue("implement", { apiKeySource: ON_KEY, costUsd: 10.53 });
    runner.queue("verify", stageResult({ result: PASSING_VERDICT, apiKeySource: ON_KEY, costUsd: 0.42 }));

    expect(await run({}, "api-key")).toMatchObject({ outcome: "merged" });

    expect(billing.spendUsd).toBeCloseTo(10.95);
    expect(billing.spendUnreported).toBe(false);
    expect(logged.join("\n")).not.toMatch(/\$\d/);
    expect(progressTable()).not.toMatch(/\$\d/);
  });

  it("is at least the spend when a Stage on the key reported no figure", async () => {
    runner.queue("implement", { apiKeySource: ON_KEY });
    runner.queue("verify", stageResult({ result: PASSING_VERDICT, apiKeySource: ON_KEY, costUsd: 0.42 }));

    await run({}, "api-key");

    expect(billing.spendUsd).toBeCloseTo(0.42);
    expect(billing.spendUnreported).toBe(true);
  });

  it("adds a figure that is only part of a Stage's, and says the spend is at least that", async () => {
    runner.queue("implement", { apiKeySource: ON_KEY, costUsd: 6.2, costIncomplete: true });
    runner.queue("verify", stageResult({ result: PASSING_VERDICT, apiKeySource: ON_KEY, costUsd: 0.42 }));

    await run({}, "api-key");

    expect(billing.spendUsd).toBeCloseTo(6.62);
    expect(billing.spendUnreported).toBe(true);
  });

  it("leaves out a Stage that printed no init event, figure or none", async () => {
    runner.queue("implement", { costUsd: 3 });

    await run({}, "api-key");

    expect(billing).toMatchObject({ spendUsd: 0, spendUnreported: false });
  });

  it("keeps a stray Stage's figure on the stray, out of the spend", async () => {
    runner.queue("implement", { apiKeySource: "apiKeyHelper", costUsd: 4.15 });

    await run({}, "api-key");

    expect(billing.strays).toEqual([
      { ticket: TICKET, stage: "implement", apiKeySource: "apiKeyHelper", costUsd: 4.15 },
    ]);
    expect(billing.spendUsd).toBe(0);
  });

  it("counts nothing on a subscription Run, but says when a Stage used extra usage", async () => {
    runner.queue("implement", { apiKeySource: "none", costUsd: 7.5, extraUsage: true });

    await run();

    expect(billing).toMatchObject({ spendUsd: 0, spendUnreported: false, extraUsage: true });
  });
});

describe("a red CI the base branch fails a Check of too", () => {
  const state = () => workspace.state(TICKET);
  const MERGE_BASE = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
  const baseWorktree = join(repoRoot, ".worktrees", "base-1a2b3c4d5e6f");
  /** The Checks the pipeline ran at the merge-base, in order. */
  const atBase = () =>
    workspace.ranChecks.filter((check) => check.cwd === baseWorktree).map((check) => check.command);
  /** The pipeline's own Notes, wherever they went. */
  const pipelineNotes = () =>
    tracker.comments.filter(({ body }) => body.includes("\nFrom the pipeline, releasing #"));

  it("releases the Ticket with its fix budget unspent when the merge-base fails a Check", async () => {
    tracker.ci = RED_CI;
    workspace.failBaseCheck("npm test", "FAIL src/date.test.ts");

    const outcome = await run();

    expect(outcome).toEqual({
      outcome: "released",
      ticket: TICKET,
      title: "Skeleton: one Ticket end to end",
      branch: BRANCH,
      stage: "ci",
      cause: "failing-base",
      failingBase: { commit: MERGE_BASE, command: "npm test" },
      notes: [
        {
          origin: TICKET,
          stage: "pipeline",
          issue: 200,
          opened: true,
          summary: "The base branch `main` fails `npm test`.",
        },
      ],
    });
    expect(runner.stages()).toEqual(["implement", "verify"]);
    expect(atBase()).toEqual(["npm test"]);
    expect(checksOnBranch()).toEqual([]);
    expect(workspace.calls).toContain(`createDetachedWorktree:${MERGE_BASE}`);
    expect(workspace.calls).toContain(`removeWorktree:${baseWorktree}`);
    expect(workspace.worktrees.has(baseWorktree)).toBe(false);
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-agent"]);
    expect(tracker.issue(TICKET).assignees).toEqual([]);
    expect(state()).toMatchObject({ state: "implemented", fixUsed: false, rebaseFirst: true });
    expect(progressTable()).toContain("| ci | ⏸ `npm test` fails on the base branch |");
    expect(tracker.pullRequest(100).merged).toBe(false);
  });

  it("posts one Note on the standing Notes issue, naming the Check and quoting its output there and CI's logs on the branch", async () => {
    tracker.ci = {
      state: "failed",
      summary: "checks/test failed",
      excerpt: "test\nFAIL src/clock.test.ts\n  2246 ms is not below 2000 ms",
    };
    workspace.failBaseCheck("npm test", "FAIL src/date.test.ts\n  expected 2026 to be 2025");

    await run();

    const [note, ...more] = pipelineNotes();
    expect(more).toEqual([]);
    expect(note?.issue).toBe(200);
    expect(note?.body).toContain("**The base branch `main` fails `npm test`.**");
    expect(note?.body).toContain(`at ${MERGE_BASE}, the merge-base of \`${BRANCH}\` with \`main\``);
    expect(note?.body).toContain("```\nFAIL src/date.test.ts\n  expected 2026 to be 2025\n```");
    expect(note?.body).toContain(
      `CI on the pull request from \`${BRANCH}\` reported checks/test failed. The tail of the failing jobs' logs:\n\n\`\`\`\ntest\nFAIL src/clock.test.ts\n  2246 ms is not below 2000 ms\n\`\`\``,
    );
    // Nobody's Ticket is commented on: the Ticket did nothing wrong.
    expect(notices().filter(({ issue }) => issue === TICKET)).toEqual([]);
  });

  it("keeps a fix budget an earlier failure spent, as it was", async () => {
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));
    tracker.ci = RED_CI;
    workspace.failBaseCheck("npm run typecheck", "error TS2345");

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "released", stage: "ci", cause: "failing-base" });
    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify"]);
    expect(state()).toMatchObject({ fixUsed: true, rebaseFirst: true });
  });

  it("releases rather than hands off a Ticket whose budget was already spent", async () => {
    workspace.recordState({
      ticket: TICKET,
      branch: BRANCH,
      state: "implemented",
      fixUsed: true,
      runId: "run-0",
      updatedAt: "2026-09-17T09:00:00.000Z",
    });
    workspace.worktrees.set(worktree, BRANCH);
    workspace.branches.add(BRANCH);
    tracker.ci = RED_CI;
    workspace.failBaseCheck("npm test", "FAIL src/date.test.ts");

    expect(await run()).toMatchObject({ outcome: "released", cause: "failing-base" });
    expect(state()).toMatchObject({ fixUsed: true });
  });

  it("spends the fix budget when the merge-base could not be checked out", async () => {
    tracker.queueCi(RED_CI);
    workspace.failing.set(`createDetachedWorktree:${MERGE_BASE}`, new Error("disk full"));

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify"]);
    expect(logged.some((line) => line.includes("disk full"))).toBe(true);
  });

  it("releases a Ticket whose CI failed when the merge-base fails one of the Check commands", async () => {
    tracker.ci = { state: "failed", summary: "checks/typecheck failed", excerpt: "typecheck\nerror TS2322" };
    workspace.failBaseCheck("npm run typecheck", "error TS2345");

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "released",
      stage: "ci",
      cause: "failing-base",
      failingBase: { commit: MERGE_BASE, command: "npm run typecheck" },
    });
    // Every Check command until the first the merge-base fails.
    expect(atBase()).toEqual(["npm test", "npm run typecheck"]);
    expect(runner.stages()).toEqual(["implement", "verify"]);
    expect(progressTable()).toContain("| ci | ⏸ `npm run typecheck` fails on the base branch |");
    expect(pipelineNotes()[0]?.body).toContain("From the pipeline, releasing #2 at ci");
    // The branch's part is the failing jobs' logs a fix Stage would have been handed.
    expect(pipelineNotes()[0]?.body).toContain(
      `CI on the pull request from \`${BRANCH}\` reported checks/typecheck failed. The tail of the failing jobs' logs:\n\n\`\`\`\ntypecheck\nerror TS2322\n\`\`\``,
    );
    expect(state()).toMatchObject({ fixUsed: false, pullRequest: 100, rebaseFirst: true });
    expect(tracker.pullRequest(100).merged).toBe(false);
  });

  it("gives the Landing up before it runs the Checks at the merge-base for a red CI", async () => {
    tracker.ci = { state: "failed", summary: "checks/typecheck failed", excerpt: "" };
    workspace.failBaseCheck("npm test", "FAIL");
    const landing = new Landing();
    const entered: boolean[] = [];
    const runCheck = workspace.runCheck.bind(workspace);
    workspace.runCheck = async (command, cwd, timeoutMs) => {
      if (cwd === baseWorktree) {
        const other = landing.turn();
        let inside = false;
        void other.enter().then(() => {
          inside = true;
        });
        await settle();
        entered.push(inside);
        other.leave();
      }
      return runCheck(command, cwd, timeoutMs);
    };
    const settings = config();

    const outcome = await processTicket(
      {
        tracker,
        runner,
        workspace,
        config: settings,
        repoRoot,
        runId: "run-1",
        version: VERSION,
        credential: "subscription",
        pluginDir: FAKE_PLUGIN_DIR,
        billing: emptyBilling(),
        baseBranch: "main",
        landing,
        standingNotes: new StandingNotes(),
        baseChecks: new BaseBranchChecks(),
        selfHosted: false,
        transcriptHome,
      },
      TICKET,
    );

    expect(outcome).toMatchObject({ outcome: "released", stage: "ci" });
    expect(entered).toEqual([true]);
  });

  it("spends the fix budget on a red CI the merge-base passes every Check of", async () => {
    tracker.queueCi({ state: "failed", summary: "checks/build failed", excerpt: "" });

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(atBase()).toEqual(["npm test", "npm run typecheck"]);
    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify"]);
    expect(progressTable()).toContain("| ci | ❌ failed |");
    expect(pipelineNotes()).toEqual([]);
  });
});

describe("Tickets in several Lanes failing against one merge-base", () => {
  const SECOND = 3;

  it("run the Check there once between them and post one Note", async () => {
    tracker.addIssue({ number: SECOND, title: "The second Ticket" });
    tracker.ci = { state: "failed", summary: "checks/test failed", excerpt: "FAIL src/clock.test.ts" };
    workspace.failBaseCheck("npm test", "FAIL src/date.test.ts");
    const settings = config({ lanes: 2 });
    const shared: Pipeline = {
      tracker,
      runner,
      workspace,
      config: settings,
      repoRoot,
      runId: "run-1",
      version: VERSION,
      credential: "subscription",
      pluginDir: FAKE_PLUGIN_DIR,
      billing: emptyBilling(),
      baseBranch: "main",
      landing: new Landing(),
      standingNotes: new StandingNotes(),
      baseChecks: new BaseBranchChecks(),
      selfHosted: false,
      transcriptHome,
    };

    const outcomes = await Promise.all([processTicket(shared, TICKET), processTicket(shared, SECOND)]);

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["released", "released"]);
    const atBase = workspace.ranChecks.filter((check) => check.cwd.includes("/base-"));
    expect(atBase.map((check) => check.command)).toEqual(["npm test"]);
    const notes = tracker.comments.filter(({ body }) => body.includes("From the pipeline"));
    expect(notes).toHaveLength(1);
    // It quotes the branch of the Ticket that posted it, the one its provenance names.
    const poster = /releasing #(\d+) at/.exec(notes[0]?.body ?? "")?.[1];
    expect(notes[0]?.body).toContain(`CI on the pull request from \`agent/${poster}\``);
    expect(notes[0]?.body).toContain("```\nFAIL src/clock.test.ts\n```");
    expect(outcomes.flatMap((outcome) => ("notes" in outcome ? outcome.notes : []))).toHaveLength(1);
  });
});

describe("resuming a Ticket released over a failing base branch", () => {
  function releasedOverBase(): void {
    workspace.recordState({
      ticket: TICKET,
      branch: BRANCH,
      state: "implemented",
      fixUsed: false,
      rebaseFirst: true,
      runId: "run-0",
      updatedAt: "2026-09-17T09:00:00.000Z",
    });
    workspace.worktrees.set(worktree, BRANCH);
    workspace.branches.add(BRANCH);
  }

  it("rebases onto the base branch, as the remote holds it, before verify grades it", async () => {
    releasedOverBase();
    const seen = stateAtEachStage();

    expect(await run()).toMatchObject({ outcome: "merged" });

    // verify discards its scratch work as soon as it comes back.
    const verified = workspace.calls.indexOf(`discardChanges:${worktree}`);
    expect(workspace.calls.slice(0, verified)).toEqual(
      expect.arrayContaining(["pullBase", "rebase", `push:${BRANCH}`]),
    );
    expect(workspace.calls.indexOf("pullBase")).toBeLessThan(workspace.calls.indexOf("rebase"));
    // Once: the rebase is not owed again by a Run that resumes after this one.
    expect(seen[0]?.state).not.toHaveProperty("rebaseFirst");
  });

  it("sends a conflicting rebase to the conflict Stage before verify, so it is not released over the same commit again", async () => {
    releasedOverBase();
    workspace.conflictOnce(CONFLICT);
    const seen = stateAtEachStage();

    expect(await run()).toMatchObject({ outcome: "merged" });

    expect(runner.stages()).toEqual(["conflict", "verify"]);
    expect(workspace.calls.indexOf("rebaseState")).toBeLessThan(
      workspace.calls.indexOf(`discardChanges:${worktree}`),
    );
    // Nor is a Check run on the resolution: verify and CI grade it.
    expect(checksOnBranch()).toEqual([]);
    expect(seen[0]?.state).toMatchObject({ rebaseFirst: true });
    expect(seen[1]?.state).not.toHaveProperty("rebaseFirst");
  });

  it("spends the fix budget on a conflict the conflict Stage could not resolve, as at the Landing", async () => {
    releasedOverBase();
    workspace.conflictOnce(CONFLICT);
    workspace.rebaseStateAfterStage = UNRESOLVED;

    expect(await run()).toMatchObject({ outcome: "merged" });

    expect(runner.stages()).toEqual(["conflict", "fix", "verify"]);
    expect(runner.prompts("fix")[0]).toContain(CONFLICT);
  });

  it("is not rebased first when it was released for any other reason", async () => {
    releasedOverBase();
    workspace.recordState({ ...(workspace.state(TICKET) as TicketState), rebaseFirst: false });

    await run();

    const verified = workspace.calls.indexOf(`discardChanges:${worktree}`);
    expect(verified).toBeGreaterThan(-1);
    expect(workspace.calls.slice(0, verified)).not.toContain("rebase");
  });
});

describe("the state file a claimed Ticket keeps", () => {
  it("is written as part of the claim, before any Stage runs", async () => {
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

  it("names the version that wrote it, on every write", async () => {
    const seen = stateAtEachStage();

    await run();

    // Every stamp of one Run is the same string, and there is at least one.
    expect(seen.length).toBeGreaterThan(0);
    expect([...new Set(seen.map(({ state }) => state?.version))]).toEqual([VERSION]);
  });

  it("is on disk before the claim reaches the board", async () => {
    let atClaim: TicketState | undefined;
    const assign = tracker.assign.bind(tracker);
    tracker.assign = async (number, assignee) => {
      atClaim = workspace.state(TICKET);
      return assign(number, assignee);
    };

    await run();

    // A claim no state file names is what the order rules out: a crash between
    // the two writes leaves a Ticket nobody claimed, which resumes itself.
    expect(atClaim).toMatchObject({ state: "claimed", branch: BRANCH });
  });

  it("records the title the implement Stage answered, for a Run that resumes after it", async () => {
    runner.queue("implement", titled("feat(cli): do the whole thing"));
    const seen = stateAtEachStage();

    await run();

    expect(seen.find(({ stage }) => stage === "verify")?.state).toMatchObject({
      title: "feat(cli): do the whole thing",
    });
  });

  it("records the body, problem and solution the implement Stage answered", async () => {
    runner.queue(
      "implement",
      described({ body: "## Summary", problem: "There was no flag.", solution: "It adds one." }),
    );
    const seen = stateAtEachStage();

    await run();

    expect(seen.find(({ stage }) => stage === "verify")?.state).toMatchObject({
      body: "## Summary",
      problem: "There was no flag.",
      solution: "It adds one.",
    });
  });

  it("records nothing for a body, problem or solution answered blank", async () => {
    runner.queue("implement", described({ body: " ", problem: "", solution: "\n" }));
    const seen = stateAtEachStage();

    await run();

    const state = seen.find(({ stage }) => stage === "verify")?.state;
    expect(state).not.toHaveProperty("body");
    expect(state).not.toHaveProperty("problem");
    expect(state).not.toHaveProperty("solution");
  });

  it("keeps the recorded title through a hand-off", async () => {
    runner.queue("implement", titled("feat(cli): do the whole thing"));
    tracker.ci = RED_CI;

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off" });
    expect(workspace.state(TICKET)).toMatchObject({ title: "feat(cli): do the whole thing" });
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
    // Storage that will not take the state, so the very first write fails.
    workspace.stateWriteFailure = new Error("ENOTDIR: not a directory");

    await expect(run()).rejects.toThrow();

    // Nothing was claimed, so there is no claim for a later Run to be stuck on.
    expect(tracker.issue(TICKET).assignees).toEqual([]);
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-agent"]);
    expect(runner.requests).toEqual([]);
  });

  it("names the pull request once it is open", async () => {
    let atCi: TicketState | undefined;
    const waitForCi = tracker.waitForCi.bind(tracker);
    tracker.waitForCi = async (number, timeoutMs, wait) => {
      atCi = workspace.state(TICKET);
      return waitForCi(number, timeoutMs, wait);
    };

    await run();

    expect(atCi).toMatchObject({ state: "implemented", pullRequest: 100 });
  });

  it("records the fix budget once the fix Stage has come back, not before it runs", async () => {
    tracker.queueCi(RED_CI);
    const seen = stateAtEachStage();

    expect(await run()).toMatchObject({ outcome: "merged" });

    expect(seen.map(({ stage, state }) => [stage, state?.fixUsed])).toEqual([
      ["implement", false],
      ["verify", false],
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

  it("is kept once the Ticket is handed off, with the fix budget given back", async () => {
    tracker.ci = RED_CI;

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
 * was killed. The claim is still on the board and the state file is still beside
 * the worktree, which together is what says so (GLOSSARY.md).
 */
describe("resuming a stranded Ticket", () => {
  /** Exactly what a killed Run leaves: the claim, the worktree, the state file. */
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

  it("keeps the claim it already has, re-assigning and relabelling nothing", async () => {
    strandedTicket();

    await run();

    expect(tracker.calls).not.toContain(`assign:${TICKET}:pipeline-user`);
    expect(tracker.calls).not.toContain(`addLabel:${TICKET}:in-progress`);
    expect(tracker.calls).not.toContain(`removeLabel:${TICKET}:ready-for-agent`);
  });

  it("writes the pull request and the squash commit from the body, problem and solution recorded", async () => {
    strandedTicket({ body: "## Summary", problem: "There was no flag.", solution: "It adds one." });

    await run();

    expect(tracker.pullRequest(100).body).toBe(`Closes #${TICKET}\n\n## Summary\n`);
    expect(tracker.pullRequest(100).squashCommit?.body).toBe(
      `Closes #${TICKET}\n\nThere was no flag.\n\nIt adds one.\n`,
    );
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
    tracker.ci = RED_CI;

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "ci" });
    expect(runner.stages()).toEqual(["verify"]);
    // Kept, and with the budget back: the human this is handed to is the reason
    // the next Run gets to buy a fix Stage again.
    expect(workspace.state(TICKET)).toMatchObject({ fixUsed: false });
  });

  it("still pushes and opens a draft pull request when it is handed off in its own worktree", async () => {
    strandedTicket({ fixUsed: true });
    tracker.ci = RED_CI;

    const outcome = await run();

    // The worktree is one this Run was resumed into, so a Stage of it could
    // have left work there and the hand-off pushes as it always did.
    expect(outcome).toMatchObject({ outcome: "handed-off", pullRequest: 100 });
    expect(workspace.pushes).toEqual([{ cwd: worktree, branch: BRANCH }]);
    expect(handoffBody()).toContain("PR #100 (draft)");
  });

  it("aborts a rebase the killed Run left in the worktree before verify grades it", async () => {
    strandedTicket();

    await run();

    expect(workspace.aborts).toBe(1);
    expect(workspace.calls.indexOf("abortRebase")).toBeLessThan(
      workspace.calls.indexOf(`discardChanges:${worktree}`),
    );
  });

  it("runs no Check on the branch it resumes, going on to verify", async () => {
    strandedTicket();

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(workspace.ranChecks).toEqual([]);
    expect(runner.stages()).toEqual(["verify"]);
  });

  it("sends a fix Stage in for work no commit carries in the worktree it resumes, on a setup row", async () => {
    strandedTicket();
    workspace.uncommitted = ["src/cli.ts"];
    runner.leaves("fix", () => {
      workspace.commits.push("fix(cli): commit what was left (#2)");
      workspace.uncommitted = [];
    });

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["fix", "verify"]);
    expect(runner.prompts("fix")[0]).toContain("src/cli.ts");
    expect(progressTable()).toContain("| setup | ❌ uncommitted work |");
    expect(workspace.state(TICKET)).toBeUndefined();
  });

  it("hands a resumed Ticket off at setup over work no commit carries when its fix budget is spent", async () => {
    strandedTicket({ fixUsed: true });
    workspace.uncommitted = ["src/cli.ts"];

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "setup" });
    expect(runner.stages()).toEqual([]);
    expect(handoffBody()).toContain("the worktree holds changes no commit carries");
    expect(progressTable()).toContain("| setup | ❌ uncommitted work |");
  });

  it("is taken from the top, in place, when its worktree and branch are gone", async () => {
    strandedTicket();
    workspace.worktrees.delete(worktree);
    workspace.branches.delete(BRANCH);

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(workspace.calls).toContain(`createWorktree:${BRANCH}`);
    expect(runner.stages()).toEqual(["implement", "verify"]);
    // Nothing was re-assigned or relabelled: the claim was already this Run's.
    expect(tracker.calls).not.toContain(`assign:${TICKET}:pipeline-user`);
  });

  it("says it was taken from the top, still claimed, and names no branch", async () => {
    strandedTicket();
    workspace.worktrees.delete(worktree);
    workspace.branches.delete(BRANCH);

    await run();

    // The whole line, and the only one of its kind: the branch is still
    // `agent/<n>` here, and the implement Stage's line names it once it has its name.
    expect(logged.filter((line) => line.startsWith(`#${TICKET} taken from the top`))).toEqual([
      `#${TICKET} taken from the top, still claimed`,
    ]);
    expect(logged.indexOf(`#${TICKET} taken from the top, still claimed`)).toBeLessThan(
      logged.findIndex((line) => line.startsWith(`#${TICKET} implemented · `)),
    );
  });

  it("is handed off at setup when its branch outlived its worktree", async () => {
    strandedTicket();
    workspace.worktrees.delete(worktree);

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "setup" });
    expect(handoffBody()).toContain(`git branch -D ${BRANCH}`);
    expect(workspace.calls).not.toContain(`createWorktree:${BRANCH}`);
  });

  it("is refused as claimed when there is no state file beside it", async () => {
    const issue = tracker.issue(TICKET);
    issue.assignees = ["pipeline-user"];
    issue.labels = ["in-progress"];

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "skipped", reason: "claimed" });
    expect(runner.requests).toEqual([]);
    expect(tracker.comments).toEqual([]);
  });

  it("is refused when the claim on it is somebody else's, state file or not", async () => {
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
  /** Leave behind exactly what a release leaves: a worktree, a branch, a state file. */
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

  it("carries on at verify rather than implementing the Ticket again", async () => {
    released();

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["verify"]);
    expect(workspace.calls).not.toContain(`createWorktree:${BRANCH}`);
    // Nothing is branched, so nothing is in the way: the branch is not asked about.
    expect(workspace.calls).not.toContain(`hasBranch:${BRANCH}`);
    // Nor is a Check run on the branch it resumes.
    expect(workspace.ranChecks).toEqual([]);
  });

  it("runs the implement Stage again when that is what the limit stopped", async () => {
    released({ state: "claimed" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["implement", "verify"]);
    expect(workspace.calls).not.toContain(`createWorktree:${BRANCH}`);
    expect(runner.requests[0]?.cwd).toBe(worktree);
  });

  it("works on the branch the state file names, whatever the Ticket is called now", async () => {
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
      `addLabel:${TICKET}:in-progress`,
      `assign:${TICKET}:pipeline-user`,
      `removeLabel:${TICKET}:ready-for-agent`,
    ]);
  });

  it("honours a fix budget an earlier Run had already spent", async () => {
    released({ fixUsed: true });
    tracker.ci = RED_CI;

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "ci" });
    expect(runner.stages()).toEqual(["verify"]);
    expect(handoffBody()).toContain("after the fix budget was used");
  });

  it("still buys a fix Stage when the budget came back unspent", async () => {
    released();
    tracker.queueCi(RED_CI);

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["verify", "fix", "verify"]);
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

  it("titles the pull request with the title the state file recorded", async () => {
    released({ title: "feat: name the pipeline ticket-runner" });

    await run();
    const pr = tracker.pullRequest(100);

    expect(runner.stages()).toEqual(["verify"]);
    expect(pr.title).toBe("feat: name the pipeline ticket-runner");
    expect(pr.squashCommit?.subject).toBe("feat: name the pipeline ticket-runner (#100)");
  });

  it("titles a draft pull request the hand-off opens with the title an earlier Run recorded", async () => {
    released({ title: "feat: name the pipeline ticket-runner" });
    runner.queue("verify", { ok: false, failure: "timed-out" });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off" });
    expect(tracker.pullRequest(100).draft).toBe(true);
    expect(tracker.pullRequest(100).title).toBe("feat: name the pipeline ticket-runner");
  });

  it("retitles the pull request the earlier Run opened with the recorded title", async () => {
    tracker.pullRequests.push({
      number: 100,
      base: "main",
      head: BRANCH,
      title: "chore: license the pipeline under MIT",
      body: `Closes #${TICKET}`,
      draft: false,
      merged: false,
    });
    released({ pullRequest: 100, title: "feat: name the pipeline ticket-runner" });

    await run();

    expect(tracker.pullRequest(100).title).toBe("feat: name the pipeline ticket-runner");
  });

  it("clears the state file once the resumed Ticket merges", async () => {
    released();

    await run();

    expect(workspace.states.has(TICKET)).toBe(false);
  });

  it("keeps the state file when the resumed Ticket is handed off", async () => {
    released({ fixUsed: true });
    tracker.ci = RED_CI;

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
    // And the state file nothing can resume from is gone, so the next Run is
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
  /** The state a Run on some Host recorded, and the branch it pushed. */
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
      expect(workspace.ranChecks).toEqual([]);
    });

    it("runs the implement Stage in it when that is where the Ticket stopped", async () => {
      recorded({ state: "claimed" });

      await run();

      expect(runner.stages()).toEqual(["implement", "verify"]);
      expect(runner.requests[0]?.cwd).toBe(worktree);
      expect(workspace.calls).not.toContain(`createWorktree:${BRANCH}`);
    });

    it("resumes a Stranded Ticket another Host left, keeping its claim", async () => {
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
          `the worktree at ${SHOWN_WORKTREE} and the branch ${BRANCH} on the remote have parted`,
        );
        expect(handoffBody()).toContain(
          `\`git worktree remove ${SHOWN_WORKTREE} && git branch -D ${BRANCH}\``,
        );
        expect(handoffBody()).toContain(`worktree \`${SHOWN_WORKTREE}\``);
        expect(handoffBody()).not.toContain(repoRoot);
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

      it("names the worktree relative to the checkout in the draft body of a pull request already open", async () => {
        workspace.recordState({
          ticket: TICKET,
          branch: BRANCH,
          state: "implemented",
          fixUsed: false,
          pullRequest: 100,
          runId: "run-0",
          updatedAt: "2026-09-17T09:00:00.000Z",
        });
        tracker.pullRequests.push({
          number: 100,
          base: "main",
          head: BRANCH,
          title: "feat: x",
          body: "Closes #2",
          draft: false,
          merged: false,
        });

        const outcome = await run();

        if (outcome.outcome !== "handed-off") throw new Error("the Ticket was not handed off");
        expect(outcome.failure).toContain(`the worktree at ${SHOWN_WORKTREE} and the branch`);
        expect(outcome.failure).not.toContain(repoRoot);
        const pr = tracker.pullRequest(100);
        expect(pr.draft).toBe(true);
        expect(pr.body).toContain(
          `\`git worktree remove ${SHOWN_WORKTREE} && git branch -D ${BRANCH}\``,
        );
        expect(pr.body).not.toContain(repoRoot);
      });

      it("pushes nothing over the remote branch and opens no draft pull request", async () => {
        const outcome = await run();

        expect(outcome).not.toHaveProperty("pullRequest");
        expect(workspace.calls).not.toContain(`push:${BRANCH}`);
        expect(tracker.pullRequests).toEqual([]);
      });

      it("keeps the state, so the Ticket resumes once a human has chosen a side", async () => {
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

  it("opens no draft pull request, because there is no worktree to push out of", async () => {
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
    // off keeps its state file and resumes without ever reaching here.
    workspace.worktrees.set(worktree, BRANCH);

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "handed-off",
      stage: "setup",
      failure: `the branch ${BRANCH} already exists and is checked out at ${SHOWN_WORKTREE}; \
finish the work there by hand, or throw it away with \`git worktree remove ${SHOWN_WORKTREE} && \
git branch -D ${BRANCH}\`, then relabel the Ticket ready-for-agent`,
    });
    // The advice a branch git is holding cannot take: `git branch -D` on its own.
    expect(handoffBody()).not.toContain(`\`git branch -D ${BRANCH}\``);
    expect(workspace.calls).not.toContain(`createWorktree:${BRANCH}`);
    // The worktree is on disk here, so the hand-off still sends the human to it.
    expect(handoffBody()).toContain(`worktree \`${SHOWN_WORKTREE}\``);
    expect(handoffBody()).not.toContain(repoRoot);
    // And the state file the claim wrote goes, alone among hand-offs: no Stage
    // of this Run ran in there, so a later resume would implement over a human.
    expect(workspace.states.has(TICKET)).toBe(false);
  });

  it("pushes nothing and opens no draft pull request over the worktree it names", async () => {
    workspace.worktrees.set(worktree, BRANCH);

    const outcome = await run();

    // No Stage of this Run ran in there: what the branch carries is a human's
    // work, which the pipeline neither writes to the remote nor presents as
    // this Run's in a pull request that says `Closes #<n>`.
    expect(outcome).not.toHaveProperty("pullRequest");
    expect(workspace.calls).not.toContain(`push:${BRANCH}`);
    expect(tracker.pullRequests).toEqual([]);
    expect(handoffBody()).toContain(`Branch \`${BRANCH}\``);
    expect(handoffBody()).not.toContain("PR #");
  });

  it("says nothing about a draft pull request it never set out to open", async () => {
    workspace.worktrees.set(worktree, BRANCH);

    const outcome = await run();

    // The line a failed attempt logs reads as if something had gone wrong.
    expect(logged.some((line) => line.includes("could not open a draft pull request"))).toBe(false);
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
    tracker.queueCi(RED_CI);
    runner.queue("fix", { ok: false, failure: "rate-limited" });

    expect(await run()).toMatchObject({ outcome: "released", stage: "fix" });
    // CI passes on the second Run, so the budget it got back is unspent and
    // the fix Stage the limit stopped is not owed a second one.
    expect(await run()).toMatchObject({ outcome: "merged" });

    expect(stages()).toEqual(["implement", "verify", "fix", "verify"]);
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

/** The error a failed command throws, as the adapters throw it. */
function failure(command: string, args: string[], output: string): Error {
  try {
    throwOnFailure(command, args, failedExecution(output));
  } catch (error) {
    return error as Error;
  }
  throw new Error("throwOnFailure did not throw");
}

const PUBLICKEY =
  "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.";
const PULL = ["pull", "--ff-only", "origin", "main"];
/** git refusing the pull of the base branch because it cannot authenticate with the remote. */
const unreachable = () => failure("git", PULL, PUBLICKEY);
/** GitHub failing on its own side, as a call that kept failing after every try throws it. */
const badGateway = (args = ["api", "--method", "POST", "repos/{owner}/{repo}/pulls"]) =>
  failure("gh", args, "gh: Bad Gateway (HTTP 502)\n{}");

describe("releasing a Ticket GitHub or the remote failed on its own side", () => {
  const state = () => workspace.state(TICKET);

  it("releases a Ticket whose pull of the base branch cannot authenticate with the remote", async () => {
    workspace.pullBaseFailure = unreachable();

    const outcome = await run();

    expect(outcome).toEqual({
      outcome: "released",
      ticket: TICKET,
      title: "Skeleton: one Ticket end to end",
      branch: BRANCH,
      stage: "rebase",
      cause: "remote",
      fault: {
        command: "git pull --ff-only origin main",
        line: "git@github.com: Permission denied (publickey).",
      },
      notes: [],
    });
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-agent"]);
    expect(tracker.issue(TICKET).assignees).toEqual([]);
    expect(notices()).toEqual([]);
    expect(tracker.pullRequests).toEqual([]);
    expect(state()).toMatchObject({ state: "implemented", fixUsed: false });
    expect(state()?.rebaseFirst).toBeUndefined();
    expect(progressTable()).toContain("| rebase | ⏸ remote unreachable | – | – |");
  });

  it("releases a Ticket whose pull request GitHub kept failing to open", async () => {
    tracker.createPullRequest = async () => {
      throw badGateway();
    };

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "released",
      stage: "pr",
      cause: "github",
      fault: {
        command: "gh api --method POST repos/{owner}/{repo}/pulls",
        line: "gh: Bad Gateway (HTTP 502)",
      },
    });
    expect(notices()).toEqual([]);
    expect(progressTable()).toContain("| pr | ⏸ GitHub failure |");
  });

  it("releases a Ticket whose answer from GitHub was not complete JSON", async () => {
    tracker.waitForCi = async () => {
      throw new OutsideFault("github", "gh api repos/{owner}/{repo}/pulls/100", "Unexpected end of JSON input", "x");
    };

    expect(await run()).toMatchObject({ outcome: "released", stage: "ci", cause: "github" });
  });

  it("spends no fix budget, and keeps one the Ticket's own failure spent", async () => {
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));
    workspace.pullBaseFailure = unreachable();

    expect(await run()).toMatchObject({ outcome: "released", stage: "rebase" });
    expect(state()).toMatchObject({ fixUsed: true });
  });

  it("gives back the budget of a fix Stage the fault stopped before it ran", async () => {
    tracker.queueCi(RED_CI);
    tracker.listCandidates = async () => {
      throw badGateway(["api", "repos/{owner}/{repo}/issues"]);
    };
    const standing = new StandingNotes();
    standing.current = async () => {
      throw badGateway(["api", "repos/{owner}/{repo}/issues"]);
    };

    const outcome = await processTicket(
      {
        tracker,
        runner,
        workspace,
        config: config(),
        repoRoot,
        runId: "run-1",
        version: VERSION,
        credential: "subscription",
        pluginDir: FAKE_PLUGIN_DIR,
        billing,
        baseBranch: "main",
        landing: new Landing(),
        standingNotes: standing,
        baseChecks: new BaseBranchChecks(),
        selfHosted: false,
        transcriptHome,
        log: (line) => logged.push(line),
      },
      TICKET,
    );

    expect(outcome).toMatchObject({ outcome: "released", cause: "github" });
    expect(state()).toMatchObject({ fixUsed: false });
  });

  it("releases a Ticket whose worktree the remote could not be reached for", async () => {
    workspace.createWorktree = async () => {
      throw failure(
        "git",
        ["fetch", "origin"],
        "fatal: unable to access 'https://github.com/acme/repo/': Could not resolve host: github.com",
      );
    };

    expect(await run()).toMatchObject({ outcome: "released", stage: "setup", cause: "remote" });
    expect(state()).toMatchObject({ state: "claimed" });
  });

  it("releases a Ticket whose merge-base the remote could not be reached for, rather than charging it", async () => {
    tracker.queueCi(RED_CI);
    workspace.mergeBase = async () => {
      throw failure("git", ["fetch", "origin", "main"], PUBLICKEY);
    };

    expect(await run()).toMatchObject({ outcome: "released", stage: "ci", cause: "remote" });
    expect(runner.stages()).toEqual(["implement", "verify"]);
    expect(state()).toMatchObject({ fixUsed: false });
  });

  it("still hands off a pull of the base branch that fails for any other reason", async () => {
    workspace.pullBaseFailure = failure("git", PULL, "fatal: Not possible to fast-forward, aborting.");

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "rebase" });
    expect(tracker.issue(TICKET).labels).toContain("ready-for-human");
  });

  it("still hands off a pull over uncommitted changes in the main checkout", async () => {
    workspace.pullBaseFailure = failure(
      "git",
      PULL,
      "error: Your local changes to the following files would be overwritten by merge:\n\tREADME.md",
    );

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "rebase" });
  });

  it("still hands off a GitHub 4xx", async () => {
    tracker.createPullRequest = async () => {
      throw failure("gh", ["api", "--method", "POST", "repos/{owner}/{repo}/pulls"], "gh: Validation Failed (HTTP 422)");
    };

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "pr" });
  });

  it("still hands off a git failure that is not the remote's", async () => {
    workspace.createWorktree = async () => {
      throw failure("git", ["worktree", "add"], "fatal: invalid reference: main");
    };

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "setup" });
  });

  it("leaves the Ticket claimed when its own label writes fail too", async () => {
    workspace.pullBaseFailure = unreachable();
    const addLabel = tracker.addLabel.bind(tracker);
    tracker.addLabel = async (number, label) => {
      if (label === "ready-for-agent") throw badGateway(["api", "--method", "POST", "labels"]);
      await addLabel(number, label);
    };

    expect(await run()).toMatchObject({ outcome: "released", cause: "remote" });
    expect(tracker.issue(TICKET).labels).toEqual(["in-progress"]);
    expect(tracker.issue(TICKET).assignees).toEqual(["pipeline-user"]);
    expect(state()).toMatchObject({ state: "implemented" });
  });

  it("takes ready-for-agent back off when the assignee will not come off, so the Ticket stays claimed", async () => {
    workspace.pullBaseFailure = unreachable();
    tracker.unassign = async () => {
      throw badGateway(["api", "--method", "DELETE", "assignees"]);
    };

    expect(await run()).toMatchObject({ outcome: "released", cause: "remote" });
    expect(tracker.issue(TICKET).labels).toEqual(["in-progress"]);
    expect(tracker.issue(TICKET).assignees).toEqual(["pipeline-user"]);
  });

  describe("a GitHub outage that starts during the Release's own board writes", () => {
    /** The Release's writes, in turn, after the claim's three. */
    const UNDO = ["addLabel:ready-for-agent", "unassign", "removeLabel:in-progress"];
    const CLAIM_WRITES = 3;

    /**
     * Board writes from the `from`-th of the Release on fail with a 502, for
     * `count` writes or for as long as the Release lasts.
     */
    function failBoardWrites(from: number, count = Infinity): string[] {
      const written: string[] = [];
      let failed = 0;
      const wrap = <A extends unknown[]>(name: string, write: (...args: A) => Promise<void>) =>
        async (...args: A) => {
          const label = typeof args[1] === "string" && name.endsWith("Label") ? `:${args[1]}` : "";
          written.push(`${name}${label}`);
          if (written.length > CLAIM_WRITES + from && failed < count) {
            failed++;
            throw badGateway(["api", "--method", "POST", name]);
          }
          await write(...args);
        };
      tracker.addLabel = wrap("addLabel", tracker.addLabel.bind(tracker));
      tracker.removeLabel = wrap("removeLabel", tracker.removeLabel.bind(tracker));
      tracker.assign = wrap("assign", tracker.assign.bind(tracker));
      tracker.unassign = wrap("unassign", tracker.unassign.bind(tracker));
      return written;
    }

    const claimed = () =>
      tracker.issue(TICKET).assignees.includes("pipeline-user") &&
      tracker.issue(TICKET).labels.includes("in-progress");

    it.each(UNDO.map((write, at) => [write, at]))(
      "writes the claim back whole when %s fails once",
      async (write, at) => {
        workspace.pullBaseFailure = unreachable();
        const written = failBoardWrites(at as number, 1);

        expect(await run()).toMatchObject({ outcome: "released", stage: "rebase", cause: "remote" });
        expect(written.slice(CLAIM_WRITES, CLAIM_WRITES + (at as number) + 1)).toEqual(
          UNDO.slice(0, (at as number) + 1),
        );
        expect(written[CLAIM_WRITES + (at as number)]).toBe(write);
        expect(tracker.issue(TICKET).labels).toEqual(["in-progress"]);
        expect(tracker.issue(TICKET).assignees).toEqual(["pipeline-user"]);
      },
    );

    it.each([
      ["ready-for-agent goes on", 0],
      ["the assignee comes off", 1],
    ])("leaves the Ticket claimed when it starts as %s and outlasts the Release", async (_, at) => {
      workspace.pullBaseFailure = unreachable();
      failBoardWrites(at);

      expect(await run()).toMatchObject({ outcome: "released", stage: "rebase", cause: "remote" });
      expect(claimed()).toBe(true);
    });

    it("leaves the Ticket free with its state when only in-progress is left to come off", async () => {
      workspace.pullBaseFailure = unreachable();
      failBoardWrites(2);

      expect(await run()).toMatchObject({ outcome: "released", stage: "rebase", cause: "remote" });
      expect(tracker.issue(TICKET).assignees).toEqual([]);
      expect(tracker.issue(TICKET).labels).toContain("ready-for-agent");
      expect(state()).toMatchObject({ state: "implemented", fixUsed: false });
    });

    it.each(UNDO.map((write, at) => [write, at]))(
      "is resumed by the next Run past the Stages it passed when it starts at %s",
      async (_, at) => {
        workspace.pullBaseFailure = unreachable();
        const original = {
          addLabel: tracker.addLabel,
          removeLabel: tracker.removeLabel,
          assign: tracker.assign,
          unassign: tracker.unassign,
        };
        failBoardWrites(at as number);

        expect(await run()).toMatchObject({ outcome: "released", stage: "rebase" });
        Object.assign(tracker, original);
        workspace.pullBaseFailure = undefined;

        expect(await run()).toMatchObject({ outcome: "merged" });
        expect(runner.stages()).toEqual(["implement", "verify", "verify"]);
      },
    );
  });

  it("is resumed by a later Run from the state it recorded, its fix budget as it was", async () => {
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));
    workspace.pullBaseFailure = unreachable();

    expect(await run()).toMatchObject({ outcome: "released", stage: "rebase" });
    workspace.pullBaseFailure = undefined;
    tracker.ci = RED_CI;

    // The budget the first Run's own failure spent is still spent, so the
    // second failure is a hand-off rather than a second fix Stage.
    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "ci" });
    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify", "verify"]);
  });

  it("is resumed past the Stages it already passed", async () => {
    workspace.pullBaseFailure = unreachable();

    expect(await run()).toMatchObject({ outcome: "released", stage: "rebase" });
    workspace.pullBaseFailure = undefined;

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual(["implement", "verify", "verify"]);
  });

  it("is reported released when its hand-off's own writes meet the fault", async () => {
    runner.queue("implement", { ok: false, failure: "nonzero-exit" });
    tracker.comment = async () => {
      throw badGateway(["api", "--method", "POST", "comments"]);
    };

    expect(await run()).toMatchObject({ outcome: "released", stage: "implement", cause: "github" });
    expect(tracker.issue(TICKET).labels).toContain("in-progress");
  });

  /**
   * A hand-off's writes, in turn, and how to fail each one with a 502 for as
   * long as the hand-off lasts. The comment is only ever the hand-off's own
   * by then: the progress comment's writes are logged and nothing more.
   */
  const HANDOFF_WRITES: Record<string, () => void> = {
    "the draft pull request": () => {
      tracker.convertPullRequestToDraft = async () => {
        throw badGateway(["api", "graphql"]);
      };
    },
    "the comment": () => {
      tracker.comment = async () => {
        throw badGateway(["api", "--method", "POST", "comments"]);
      };
    },
    "taking in-progress off": () => {
      const removeLabel = tracker.removeLabel.bind(tracker);
      tracker.removeLabel = async (number, label) => {
        if (label === "in-progress") throw badGateway(["api", "--method", "DELETE", "labels"]);
        await removeLabel(number, label);
      };
    },
    "putting ready-for-human on": () => {
      const addLabel = tracker.addLabel.bind(tracker);
      tracker.addLabel = async (number, label) => {
        if (label === "ready-for-human") throw badGateway(["api", "--method", "POST", "labels"]);
        await addLabel(number, label);
      };
    },
    "taking its assignee off": () => {
      tracker.unassign = async () => {
        throw badGateway(["api", "--method", "DELETE", "assignees"]);
      };
    },
  };
  const failAt = (write: string) => (HANDOFF_WRITES[write] as () => void)();

  describe("a hand-off that keeps no state, cut short", () => {
    /** A branch of the Ticket's name already here, which a human holds. */
    beforeEach(() => {
      workspace.branches.add(BRANCH);
    });

    it("is reported handed off at setup over a branch already present, with the comment failing", async () => {
      failAt("the comment");

      const outcome = await run();

      expect(outcome).toEqual({
        outcome: "handed-off",
        ticket: TICKET,
        title: "Skeleton: one Ticket end to end",
        branch: BRANCH,
        stage: "setup",
        failure: expect.stringContaining(`the branch ${BRANCH} already exists`),
        fault: {
          side: "github",
          command: "gh api --method POST comments",
          line: "gh: Bad Gateway (HTTP 502)",
        },
        notes: [],
      });
      // Left as the hand-off got it: claimed, with no state file for the
      // sweep to find, so the row is what tells a human.
      expect(tracker.issue(TICKET).labels).toEqual(["in-progress"]);
      expect(tracker.issue(TICKET).assignees).toEqual(["pipeline-user"]);
      expect(workspace.states.has(TICKET)).toBe(false);
      expect(logged).toContain(
        `#${TICKET} handed off at setup, but the hand-off was cut short · ${badGateway(["api", "--method", "POST", "comments"]).message}`,
      );
    });

    it.each([
      "the comment",
      "taking in-progress off",
      "putting ready-for-human on",
      "taking its assignee off",
    ])("is reported handed off whichever write meets the fault: %s", async (write) => {
      failAt(write);

      expect(await run()).toMatchObject({
        outcome: "handed-off",
        stage: "setup",
        fault: { side: "github", line: "gh: Bad Gateway (HTTP 502)" },
      });
      expect(workspace.states.has(TICKET)).toBe(false);
    });

    it("is reported handed off over a branch checked out in a worktree too", async () => {
      workspace.worktrees.set(worktree, BRANCH);
      failAt("taking in-progress off");

      expect(await run()).toMatchObject({ outcome: "handed-off", stage: "setup", fault: { side: "github" } });
      expect(workspace.states.has(TICKET)).toBe(false);
    });
  });

  describe("a hand-off that keeps state, cut short", () => {
    /** Red CI, once and again behind the fix Stage: handed off at ci, its pull request open. */
    beforeEach(() => {
      tracker.ci = { state: "failed", summary: "checks/build failed", excerpt: "" };
    });

    it("is reported released when the draft pull request it opens meets the fault", async () => {
      runner.queue("implement", { ok: false, failure: "nonzero-exit" });
      tracker.createPullRequest = async () => {
        throw badGateway();
      };

      expect(await run()).toMatchObject({ outcome: "released", stage: "implement", cause: "github" });
      expect(tracker.issue(TICKET).labels).toContain("in-progress");
      expect(tracker.issue(TICKET).assignees).toEqual(["pipeline-user"]);
      expect(tracker.comments.some((comment) => comment.body.includes("ticket-runner:handoff"))).toBe(false);
    });

    it.each(["the draft pull request", "the comment", "taking in-progress off"])(
      "is reported released at %s, still claimed, for the next Run to resume as stranded",
      async (write) => {
        failAt(write);

        const outcome = await run();

        expect(outcome).toMatchObject({ outcome: "released", stage: "ci", cause: "github" });
        expect(outcome).not.toHaveProperty("fault.side");
        expect(tracker.issue(TICKET).labels).toContain("in-progress");
        expect(tracker.issue(TICKET).assignees).toEqual(["pipeline-user"]);
        expect(workspace.state(TICKET)).toMatchObject({ pullRequest: 100 });
        expect(logged.some((line) => line.startsWith(`#${TICKET} could not be handed off at ci · `))).toBe(true);
      },
    );

    it.each(["putting ready-for-human on", "taking its assignee off"])(
      "is reported handed off at %s, since nothing sweeps it from there",
      async (write) => {
        failAt(write);

        const outcome = await run();

        expect(outcome).toMatchObject({
          outcome: "handed-off",
          stage: "ci",
          pullRequest: 100,
          fault: { side: "github", line: "gh: Bad Gateway (HTTP 502)" },
        });
        expect(tracker.issue(TICKET).labels).not.toContain("in-progress");
        expect(tracker.issue(TICKET).assignees).toEqual(["pipeline-user"]);
        expect(workspace.state(TICKET)).toMatchObject({ pullRequest: 100 });
      },
    );
  });
});

describe("a pull request already open on the Ticket's branch", () => {
  it("is used rather than opening a second one", async () => {
    tracker.pullRequests.push({
      number: 100,
      base: "main",
      head: BRANCH,
      title: "feat: x",
      body: "Closes #2",
      draft: false,
      merged: false,
    });

    expect(await run()).toMatchObject({ outcome: "merged", pullRequest: 100 });
    expect(tracker.pullRequests).toHaveLength(1);
    expect(tracker.calls).not.toContain("createPullRequest:101:ready");
    expect(tracker.calls).toContain("updatePullRequestTitle:100");
    expect(workspace.state(TICKET)).toBeUndefined();
  });

  it("is used by the Run resuming a Ticket released over a pull request GitHub opened all the same", async () => {
    const create = tracker.createPullRequest.bind(tracker);
    tracker.createPullRequest = async (pr) => {
      await create(pr);
      throw badGateway();
    };

    expect(await run()).toMatchObject({ outcome: "released", stage: "pr" });
    tracker.createPullRequest = create;

    expect(await run()).toMatchObject({ outcome: "merged", pullRequest: 100 });
    expect(tracker.pullRequests).toHaveLength(1);
  });
});

describe("a progress write that failed", () => {
  /** Fail the first write of a comment body carrying `row`, and no other. */
  function failWrites(row: string): void {
    const update = tracker.updateComment.bind(tracker);
    let failed = false;
    tracker.updateComment = async (id, body) => {
      if (!failed && body.includes(row)) {
        failed = true;
        throw badGateway(["api", "--method", "PATCH", "comments"]);
      }
      await update(id, body);
    };
  }

  it("is written once more when the Ticket merges", async () => {
    failWrites("| merge |");

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(progressTable()).toContain("| merge | ✅ #100 |");
  });

  it("is written once more when the Ticket is handed off", async () => {
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));
    runner.queue("verify", stageResult({ result: UNMET_VERDICT }));
    failWrites("| verify | ❌ 1 unmet | 7 | 1s |\n| fix |");
    runner.leaves("fix", () => workspace.commits.push("fix(cli): x (#2)"));

    expect(await run()).toMatchObject({ outcome: "handed-off" });
    expect(progressTable()).toMatch(/\| fix \| ✅ committed \|[^\n]*\n\| verify \| ❌ 1 unmet/);
  });

  it("is written once more when the Ticket is released", async () => {
    runner.queue("verify", { ok: false, failure: "rate-limited" });
    failWrites("| verify | ⏸");

    expect(await run()).toMatchObject({ outcome: "released" });
    expect(progressTable()).toContain("| verify | ⏸ rate limited |");
  });

  it("is not written again when the last write landed", async () => {
    await run();

    const writes = tracker.updatedComments.length + tracker.comments.filter(({ body }) => body.startsWith(PROGRESS_MARKER)).length;
    // implement, verify, ci, merge: one write each, the first a post.
    expect(writes).toBe(4);
  });
});

/**
 * A hand-off and the relabel that answers it, in one test: the second `run()` is
 * the next Run meeting a Ticket a human has handed back by moving the label to
 * `ready-for-agent`. What the hand-off left — the branch, the worktree, the
 * draft pull request and the state file — is what that Run picks up.
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

  /** A first Run that spends the fix budget and is handed off at CI. */
  async function handedOff(): Promise<void> {
    tracker.queueCi(RED_CI);
    tracker.queueCi(RED_CI);

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "ci" });
  }

  /** The relabel a human does, which is the whole of handing a Ticket back. */
  function handedBack(): void {
    tracker.issue(TICKET).labels = ["ready-for-agent"];
  }

  it("keeps the branch, the worktree, the draft pull request and the state file", async () => {
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
    // either, the claim having come off. Nothing moves until the human does.
    expect(await run()).toMatchObject({ outcome: "skipped", reason: "not-ready" });
    expect(workspace.states.has(TICKET)).toBe(true);
  });

  it("resumes from what it reached rather than implementing a second time", async () => {
    await handedOff();
    handedBack();

    expect(await run()).toMatchObject({ outcome: "merged", pullRequest: 100 });
    // One implement Stage across both Runs, which is the whole of what this
    // saves, and the one worktree the first Run made.
    expect(stages()).toEqual(["implement", "verify", "fix", "verify", "verify"]);
    expect(workspace.calls.filter((call) => call === `createWorktree:${BRANCH}`)).toHaveLength(1);
  });

  it("takes the pull request out of draft before it waits for CI", async () => {
    await handedOff();
    handedBack();
    const first = tracker.calls.length;

    await run();

    // A draft pull request often runs no workflows at all, so waiting first
    // would read as "no checks" and end the Ticket short of the merge.
    const calls = tracker.calls.slice(first);
    expect(tracker.pullRequest(100).draft).toBe(false);
    expect(calls).toContain("markPullRequestReady:100");
    expect(calls.indexOf("markPullRequestReady:100")).toBeLessThan(calls.indexOf("waitForCi:100"));
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
    tracker.queueCi(RED_CI);

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(stages()).toEqual(["implement", "verify", "fix", "verify", "verify", "fix", "verify"]);
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

  it("clears the state file once the Ticket it took back merges", async () => {
    await handedOff();
    handedBack();

    await run();

    expect(workspace.states.has(TICKET)).toBe(false);
  });
});

describe("criteria a comment added after the hand-off", () => {
  /** The criterion the body has had from the start, as the first Run graded it. */
  const ORIGINAL = "it works";
  /** The criterion a human adds in a comment before handing the Ticket back. */
  const ADDED = "it also logs";

  /** A verdict over both criteria: the original first, the added one second. */
  const graded = (original: "met" | "unmet", added: "met" | "unmet") =>
    stageResult({
      result: verdictResult(
        [
          { text: ORIGINAL, status: original, evidence: `${ORIGINAL} is ${original}` },
          { text: ADDED, status: added, evidence: `${ADDED} is ${added}` },
        ],
        original === "met" && added === "met",
      ),
    });

  /** The criterion, posted as a comment of its own, below whatever the Ticket carries. */
  function commentAdds(text: string): void {
    const { comments } = tracker.issue(TICKET);
    comments.push({ id: `human-${comments.length}`, body: `Decision:\n\n- [ ] ${text}` });
  }

  /** A first Run that spends the fix budget and is handed off at CI. */
  async function handedOff(): Promise<void> {
    tracker.queueCi(RED_CI);
    tracker.queueCi(RED_CI);

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "ci" });
  }

  function handedBack(): void {
    tracker.issue(TICKET).labels = ["ready-for-agent"];
  }

  /** The Stages the first Run took, which every test here starts from. */
  const FIRST_RUN = ["implement", "verify", "fix", "verify"];

  it("buys a fix Stage that spends no fix budget, which is still there for a later failure", async () => {
    await handedOff();
    commentAdds(ADDED);
    handedBack();
    runner.queue("verify", graded("met", "unmet"));
    runner.queue("verify", graded("met", "unmet"));
    runner.queue("verify", graded("met", "met"));

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual([...FIRST_RUN, "verify", "fix", "verify", "fix", "verify"]);
  });

  it("buys it once: a third verdict leaving the added criterion unmet is handed off", async () => {
    await handedOff();
    commentAdds(ADDED);
    handedBack();
    runner.queue("verify", graded("met", "unmet"));
    runner.queue("verify", graded("met", "unmet"));
    runner.queue("verify", graded("met", "unmet"));

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "verify" });
    expect(runner.stages()).toEqual([...FIRST_RUN, "verify", "fix", "verify", "fix", "verify"]);
  });

  it("buys it even after the fix budget has gone on another failure", async () => {
    await handedOff();
    commentAdds(ADDED);
    handedBack();
    runner.queue("verify", graded("unmet", "met"));
    runner.queue("verify", graded("met", "unmet"));
    runner.queue("verify", graded("met", "met"));

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual([...FIRST_RUN, "verify", "fix", "verify", "fix", "verify"]);
  });

  it("spends the fix budget on a verdict whose unmet criteria are all the body's", async () => {
    await handedOff();
    commentAdds(ADDED);
    handedBack();
    runner.queue("verify", graded("unmet", "met"));
    runner.queue("verify", graded("unmet", "met"));

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "verify" });
    expect(runner.stages()).toEqual([...FIRST_RUN, "verify", "fix", "verify"]);
  });

  it("spends the fix budget on a criterion a comment added before the hand-off", async () => {
    commentAdds(ADDED);
    runner.queue("verify", graded("met", "met"));
    runner.queue("verify", graded("met", "met"));
    await handedOff();
    handedBack();
    runner.queue("verify", graded("met", "unmet"));
    runner.queue("verify", graded("met", "unmet"));

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "verify" });
    expect(runner.stages()).toEqual([...FIRST_RUN, "verify", "fix", "verify"]);
  });

  it("spends the fix budget on a verdict that fails on defects alone", async () => {
    await handedOff();
    commentAdds(ADDED);
    handedBack();
    const defective = stageResult({
      result: verdictResult(
        [
          { text: ORIGINAL, status: "met", evidence: "npm test is green" },
          { text: ADDED, status: "met", evidence: "the log has the line" },
        ],
        false,
        [{ summary: "the log leaks a token", evidence: "src/log.ts:3" }],
      ),
    });
    runner.queue("verify", defective);
    runner.queue("verify", defective);

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "verify" });
    expect(runner.stages()).toEqual([...FIRST_RUN, "verify", "fix", "verify"]);
  });

  it("spends the fix budget on a Ticket never handed off, whatever comment the criterion is in", async () => {
    commentAdds(ADDED);
    runner.queue("verify", graded("met", "unmet"));
    runner.queue("verify", graded("met", "unmet"));

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "verify" });
    expect(runner.stages()).toEqual(["implement", "verify", "fix", "verify"]);
  });

  it("is still owed to the Run that resumes a Ticket released while it ran", async () => {
    await handedOff();
    commentAdds(ADDED);
    handedBack();
    runner.queue("verify", graded("met", "unmet"));
    runner.queue("fix", { ok: false, failure: "rate-limited" });

    expect(await run()).toMatchObject({ outcome: "released", stage: "fix" });
    expect(workspace.state(TICKET)).toMatchObject({ fixUsed: false });
    expect(workspace.state(TICKET)?.addedCriteriaFixUsed).toBeUndefined();

    runner.queue("verify", graded("met", "unmet"));
    runner.queue("verify", graded("met", "unmet"));
    runner.queue("verify", graded("met", "met"));

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(runner.stages()).toEqual([
      ...FIRST_RUN,
      "verify",
      "fix",
      "verify",
      "fix",
      "verify",
      "fix",
      "verify",
    ]);
  });

  it("is not bought twice across a Release and resume", async () => {
    await handedOff();
    commentAdds(ADDED);
    handedBack();
    runner.queue("verify", graded("met", "unmet"));
    runner.queue("verify", { ok: false, failure: "rate-limited" });

    expect(await run()).toMatchObject({ outcome: "released", stage: "verify" });
    expect(workspace.state(TICKET)).toMatchObject({ fixUsed: false, addedCriteriaFixUsed: true });

    runner.queue("verify", graded("met", "unmet"));
    runner.queue("verify", graded("met", "unmet"));

    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "verify" });
    expect(runner.stages()).toEqual([
      ...FIRST_RUN,
      "verify",
      "fix",
      "verify",
      "verify",
      "fix",
      "verify",
    ]);
  });

  it("is bought again each time the Ticket is handed back", async () => {
    await handedOff();
    commentAdds(ADDED);
    handedBack();
    runner.queue("verify", graded("met", "unmet"));
    runner.queue("verify", graded("met", "unmet"));
    runner.queue("verify", graded("met", "unmet"));
    expect(await run()).toMatchObject({ outcome: "handed-off", stage: "verify" });
    // The hand-off gives back the fix budget and the fix this exempts alike.
    expect(workspace.state(TICKET)?.addedCriteriaFixUsed).toBeUndefined();

    const third = "it also rotates the log";
    commentAdds(third);
    handedBack();
    const all = (last: "met" | "unmet") =>
      stageResult({
        result: verdictResult(
          [
            { text: ORIGINAL, status: "met", evidence: "green" },
            { text: ADDED, status: "met", evidence: "logged" },
            { text: third, status: last, evidence: `rotation is ${last}` },
          ],
          last === "met",
        ),
      });
    runner.queue("verify", all("unmet"));
    runner.queue("verify", all("unmet"));
    runner.queue("verify", all("met"));

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(runner.stages().slice(-5)).toEqual(["verify", "fix", "verify", "fix", "verify"]);
  });

  /** The opening of a fix Stage's brief: what paid for it and what a failure after it buys. */
  const allowance = (prompt: string | undefined) =>
    prompt?.match(/one gate failed\. (.*)/)?.[1] ?? "";

  it("tells the fix it bought that it spent no budget, and that a failure after it buys the budget's fix", async () => {
    await handedOff();
    commentAdds(ADDED);
    handedBack();
    runner.queue("verify", graded("met", "unmet"));
    runner.queue("verify", graded("unmet", "met"));
    runner.queue("verify", graded("met", "met"));

    expect(await run()).toMatchObject({ outcome: "merged" });
    const [, free, paid] = runner.prompts("fix").map(allowance);
    expect(free).toMatch(/spend none of its fix budget:/);
    expect(free).not.toMatch(/budget is spent|already spent/);
    expect(free).toMatch(/a second failure .*buys one more, which spends the fix budget/);
    expect(free).not.toMatch(/second failure of any kind hands/);
    expect(paid).toMatch(/^You are what its fix budget bought, and the budget is spent: a second failure of any kind hands the Ticket to a human\.$/);
  });

  it("tells the budget's fix that a verdict on an added criterion still buys one more, and the fix after it that nothing is left", async () => {
    await handedOff();
    commentAdds(ADDED);
    handedBack();
    runner.queue("verify", graded("unmet", "met"));
    runner.queue("verify", graded("met", "unmet"));
    runner.queue("verify", graded("met", "met"));

    expect(await run()).toMatchObject({ outcome: "merged" });
    const [, paid, free] = runner.prompts("fix").map(allowance);
    expect(paid).toMatch(/budget is spent: a second failure hands the Ticket to a human, unless .*added after the Ticket's last hand-off/);
    expect(free).toMatch(/spend none of its fix budget, which an earlier failure already spent: a second failure of any kind hands the Ticket to a human\.$/);
  });

  it("tells the budget's fix on a Ticket never handed back that a second failure hands it off", async () => {
    commentAdds(ADDED);
    runner.queue("verify", graded("met", "unmet"));

    await run();

    expect(allowance(runner.prompts("fix")[0])).toBe(
      "You are what its fix budget bought, and the budget is spent: a second failure of any kind hands the Ticket to a human.",
    );
  });

  it.each([
    ["the added criterion first", graded("met", "unmet"), graded("unmet", "met"), "added-criteria", "retry"],
    ["the body's criterion first", graded("unmet", "met"), graded("met", "unmet"), "retry", "added-criteria"],
  ])(
    "logs each fix Stage and its pass apart, so none overwrites another or the verdict that sent it, %s",
    async (_, first, second, firstDir, secondDir) => {
      await handedOff();
      commentAdds(ADDED);
      handedBack();
      const before = runner.requests.length;
      runner.queue("verify", first);
      runner.queue("verify", second);
      runner.queue("verify", second);

      expect(await run()).toMatchObject({ outcome: "handed-off", stage: "verify" });
      const ticketLogs = `${repoRoot}/.ticket-runner/runs/run-1/${TICKET}`;
      expect(runner.requests.slice(before).map((request) => [request.stage, request.logDir])).toEqual([
        ["verify", ticketLogs],
        ["fix", `${ticketLogs}/${firstDir}`],
        ["verify", `${ticketLogs}/${firstDir}`],
        ["fix", `${ticketLogs}/${secondDir}`],
        ["verify", `${ticketLogs}/${secondDir}`],
      ]);
    },
  );
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
    expect(warnings()[0]).toContain("<!-- ticket-runner:guard:spec -->");
    expect(warnings()[0]).toContain("it is a Spec, not a Ticket");
    expectUntouched();
  });

  it("takes ready-for-agent off the Spec, so no Run offers it again", async () => {
    tracker.issue(TICKET).subIssues = 4;

    await run();

    expect(tracker.issue(TICKET).labels).toEqual([]);
    expect(tracker.calls).toContain(`removeLabel:${TICKET}:ready-for-agent`);
  });

  it("tells a candidate whose every checkbox is ticked how many are", async () => {
    tracker.issue(TICKET).body = "- [x] it works\n- [X] it is documented";

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "skipped", reason: "no-criteria" });
    expect(warnings()[0]).toContain(
      "all 2 of its checkboxes are already ticked. Untick each criterion not yet done",
    );
  });

  it("skips a candidate with no acceptance criteria anywhere", async () => {
    tracker.issue(TICKET).body = "## What to build\n\nSomething good.";

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "skipped", reason: "no-criteria" });
    expect(warnings()[0]).toContain("<!-- ticket-runner:guard:no-criteria -->");
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
    expect(warnings()[0]).toContain("<!-- ticket-runner:guard:body-only-blockers -->");
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
      { id: "c0", body: "<!-- ticket-runner:guard:body-only-blockers -->\n**Skipped.**" },
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
    expect(rows()).toEqual(["implement", "verify", "ci", "merge"]);
    expect(tracker.updatedComments.length).toBeGreaterThan(0);
  });

  it("reports what each Stage did, with its turns", async () => {
    await run();

    expect(progressTable()).toContain("| implement | ✅ committed | 7 | 1s |");
    expect(progressTable()).toContain("| verify | ✅ 1 met | 7 | 1s |");
    expect(progressTable()).toContain("| merge | ✅ #100 | – | – |");
  });

  it("has no checks row, whether or not a Check command is configured", async () => {
    await run({ checks: [], checksNamed: true });
    expect(rows()).toEqual(["implement", "verify", "ci", "merge"]);
  });

  it("names the unverifiable criteria on the verify row only when there are any", async () => {
    runner.queue("verify", { result: MIXED_VERDICT });
    ticketReads("it works", "the docs say so");

    await run();

    expect(progressTable()).toContain("| verify | ✅ 1 met · 1 unverifiable | 7 | 1s |");
  });

  it("names the Run and the branch it is reporting on", async () => {
    await run();

    expect(progressTable()).toContain(`run \`run-1\` · \`${BRANCH}\``);
  });

  it("adds a row per pass when the fix budget buys a second one", async () => {
    tracker.queueCi(RED_CI);

    await run();

    expect(rows()).toEqual(["implement", "verify", "ci", "fix", "verify", "ci", "merge"]);
    expect(progressTable()).toMatch(/\| ci \| ❌ failed \| – \| \d+s \|/);
  });

  it("adds a conflict row, and nothing re-grades what it resolved before CI", async () => {
    workspace.conflictOnce(CONFLICT);

    await run();

    expect(rows()).toEqual(["implement", "verify", "conflict", "ci", "merge"]);
    expect(progressTable()).toContain("| conflict | ✅ rebased | 7 | 1s |");
  });

  it("carries on in the comment an earlier Run left, below that Run's section", async () => {
    const earlier = progressComment({
      version: "0.5.0",
      runId: "run-0",
      branch: BRANCH,
      rows: [{ point: "implement", outcome: "✅ committed", turns: 46, durationMs: 1_260_000 }],
    });
    tracker.issue(TICKET).comments.push({ id: "99", body: earlier });

    await run();

    expect(tracker.comments.filter(({ body }) => body.startsWith(PROGRESS_MARKER))).toEqual([]);
    expect(tracker.updatedComments.every(({ id }) => id === "99")).toBe(true);
    expect(progressTable()).toContain(`${earlier}\n**ticket-runner**`);
    expect(progressTable().indexOf("run \`run-1\`")).toBeGreaterThan(
      progressTable().indexOf("run \`run-0\`"),
    );
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
    tracker.ci = { state: "failed", summary: "checks/test failed", excerpt: "1 failing · expected true to be false" };

    await run();

    const handoff = tracker.comments.filter(({ body }) =>
      body.startsWith("<!-- ticket-runner:handoff -->"),
    );
    expect(handoff).toHaveLength(1);
    expect(handoff[0]?.body).toContain("1 failing · expected true to be false");

    const progress = tracker.issue(TICKET).comments.find(({ body }) =>
      body.startsWith(PROGRESS_MARKER),
    );
    expect(progress?.body).toContain("| ci | ❌ failed |");
    expect(progress?.body).not.toContain("expected true to be false");
  });

  it("leaves a guard warning a comment of its own, with no table beside it", async () => {
    tracker.issue(TICKET).body = "## What to build\n\nSomething good.";

    await run();

    expect(tracker.comments.map(({ body }) => body.split("\n")[0])).toEqual([
      "<!-- ticket-runner:guard:no-criteria -->",
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

  it("marks it as history at the claim, keeping the failure and the evidence", async () => {
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
    tracker.ci = RED_CI;

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

describe("a Target that merges by hand", () => {
  const MIXED_BODY = "- [ ] it works\n- [ ] the docs say so\n";
  const BY_HAND = { merge: false };

  beforeEach(() => {
    tracker.issue(TICKET).body = MIXED_BODY;
    runner.queue("verify", stageResult({ result: MIXED_VERDICT }));
    runner.queue(
      "implement",
      described({ body: "## Summary\n\nDoes the thing.", problem: "P.", solution: "S." }),
    );
  });

  it("hands a green Ticket off at the merge instead of merging it", async () => {
    const outcome = await run(BY_HAND);

    expect(outcome).toEqual({
      outcome: "handed-off",
      ticket: TICKET,
      title: "Skeleton: one Ticket end to end",
      branch: BRANCH,
      stage: "merge",
      failure: "left to a human, as this Target merges by hand",
      pullRequest: 100,
      notes: [],
    });
    expect(tracker.pullRequest(100).merged).toBe(false);
    expect(tracker.calls).not.toContain("squashMerge:100");
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-human"]);
    expect(tracker.issue(TICKET).assignees).toEqual([]);
  });

  it("leaves the pull request as the pr step published it", async () => {
    await run(BY_HAND);
    const pr = tracker.pullRequest(100);

    expect(pr.draft).toBe(false);
    expect(pr.title).toBe("feat(cli): do the whole thing");
    expect(pr.body).toBe(`Closes #${TICKET}\n\n## Summary\n\nDoes the thing.\n`);
    expect(tracker.calls).not.toContain("convertPullRequestToDraft:100");
    expect(tracker.calls.filter((call) => call.startsWith("updatePullRequest"))).toEqual([]);
  });

  it("says the pull request passed every gate and lists the unverifiable criteria", async () => {
    await run(BY_HAND);
    const comment = handoffBody();

    expect(comment).toContain(
      "**Handed off.** PR #100 passed every gate and waits for a human to merge it: this Target merges by hand.",
    );
    expect(comment).toContain(
      `- Branch \`${BRANCH}\` on the remote · worktree \`${SHOWN_WORKTREE}\` · PR #100`,
    );
    expect(comment).not.toContain(repoRoot);
    expect(comment).toContain("- the docs say so — the docs are not readable from here");
    expect(comment).not.toContain("Failure:");
    expect(comment).not.toContain("<details>");
  });

  it("says in the progress comment that the merge is left to a human", async () => {
    await run(BY_HAND);

    expect(progressTable()).toContain("| ci | ✅ passed |");
    expect(progressTable()).toContain("| merge | 👤 left to a human | – | – |");
  });

  it("leaves the Landing without pulling, keeps the state file and no transcripts, and ticks nothing", async () => {
    await run(BY_HAND);

    // The one pull at the Landing's door, before the rebase, and none after.
    expect(workspace.pulledBase).toEqual(["main"]);
    expect(workspace.state(TICKET)).toMatchObject({
      state: "implemented",
      branch: BRANCH,
      pullRequest: 100,
      fixUsed: false,
    });
    expect(workspace.transcripts.has(TICKET)).toBe(false);
    expect(tracker.issue(TICKET).body).toBe(MIXED_BODY);
    expect(workspace.worktrees.get(worktree)).toBe(BRANCH);
    expect(workspace.calls).not.toContain(`deleteRemoteBranch:${BRANCH}`);
  });

  it("lets the next Ticket of the Run through the Landing", async () => {
    const SECOND = 3;
    tracker.addIssue({ number: SECOND, title: "The second Ticket", body: MIXED_BODY });
    runner.queue("verify", stageResult({ result: MIXED_VERDICT }));
    const settings = config(BY_HAND);
    const shared: Pipeline = {
      tracker,
      runner,
      workspace,
      config: settings,
      repoRoot,
      runId: "run-1",
      version: VERSION,
      credential: "subscription",
      pluginDir: FAKE_PLUGIN_DIR,
      billing,
      baseBranch: await resolveBaseBranch(tracker, settings),
      landing: new Landing(),
      standingNotes: new StandingNotes(),
      baseChecks: new BaseBranchChecks(),
      selfHosted: false,
      transcriptHome,
    };
    // The first Ticket's hand-off comment waits on GitHub, inside nothing.
    const comment = tracker.comment.bind(tracker);
    let answer!: () => void;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    tracker.comment = async (number, body) => {
      if (number === TICKET && body.startsWith(HANDOFF_MARKER)) await held;
      return comment(number, body);
    };

    const first = processTicket(shared, TICKET);
    const second = processTicket(shared, SECOND);
    await settle();

    // The second Ticket reached CI while the first was still handing off.
    expect(tracker.calls).toContain("waitForCi:101");
    answer();
    expect(await first).toMatchObject({ outcome: "handed-off", stage: "merge" });
    expect(await second).toMatchObject({ outcome: "handed-off", stage: "merge" });
  });

  it("changes nothing for a Target that leaves the setting unset or true", async () => {
    expect(await run({ merge: true })).toMatchObject({ outcome: "merged", pullRequest: 100 });
    expect(tracker.pullRequest(100).merged).toBe(true);
  });

  it("resumes like any handed-off Ticket once a human relabels it", async () => {
    await run(BY_HAND);
    tracker.issue(TICKET).labels = ["ready-for-agent"];
    runner.queue("verify", stageResult({ result: MIXED_VERDICT }));

    expect(await run()).toMatchObject({ outcome: "merged", pullRequest: 100 });
    // No second implement Stage, and the one pull request.
    expect(runner.stages()).toEqual(["implement", "verify", "verify"]);
    expect(tracker.pullRequests).toHaveLength(1);
    expect(workspace.states.has(TICKET)).toBe(false);
    const handoffs = tracker
      .issue(TICKET)
      .comments.filter(({ body }) => body.startsWith(HANDOFF_MARKER));
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.body).toContain(HANDOFF_TAKEN_LINE);
  });
});

describe("a Target that merges by hand, with every criterion met", () => {
  const BY_HAND = { merge: false };
  const PR_BODY = "## Summary\n\nDoes the thing.";

  beforeEach(() => {
    ticketReads("it works");
    runner.queue("implement", described({ body: PR_BODY, problem: "P.", solution: "S." }));
  });

  it("hands the Ticket off with no hand-off comment, and everything else as it is", async () => {
    const outcome = await run(BY_HAND);

    expect(outcome).toEqual({
      outcome: "handed-off",
      ticket: TICKET,
      title: "Skeleton: one Ticket end to end",
      branch: BRANCH,
      stage: "merge",
      failure: "left to a human, as this Target merges by hand",
      pullRequest: 100,
      notes: [],
    });
    expect(tracker.comments.filter(({ body }) => body.startsWith(HANDOFF_MARKER))).toEqual([]);
    expect(notices()).toEqual([]);
    expect(tracker.issue(TICKET).labels).toEqual(["ready-for-human"]);
    expect(tracker.issue(TICKET).assignees).toEqual([]);
    const pr = tracker.pullRequest(100);
    expect(pr.merged).toBe(false);
    expect(pr.draft).toBe(false);
    expect(pr.body).toBe(`Closes #${TICKET}\n\n${PR_BODY}\n`);
    expect(progressTable()).toContain("| merge | 👤 left to a human | – | – |");
    expect(workspace.state(TICKET)).toMatchObject({
      state: "implemented",
      branch: BRANCH,
      pullRequest: 100,
      fixUsed: false,
    });
    expect(workspace.transcripts.has(TICKET)).toBe(false);
  });

  it("carries on in the progress comment it left once a human relabels it", async () => {
    await run(BY_HAND);
    tracker.issue(TICKET).labels = ["ready-for-agent"];

    expect(await run({}, "subscription", "run-2")).toMatchObject({
      outcome: "merged",
      pullRequest: 100,
    });
    // Resumed from its state file: no second implement Stage, and the one pull request.
    expect(runner.stages()).toEqual(["implement", "verify", "verify"]);
    expect(tracker.pullRequests).toHaveLength(1);
    // One progress comment, the first Run's section above the second's.
    const table = progressTable();
    expect(table.indexOf("run `run-1`")).toBeGreaterThan(-1);
    expect(table.indexOf("run `run-2`")).toBeGreaterThan(table.indexOf("run `run-1`"));
    expect(table).toContain("| merge | 👤 left to a human | – | – |");
    expect(table).toContain("| merge | ✅ #100 | – | – |");
  });
});

/**
 * A criterion that asks for nothing but the pull request's CI, or some
 * commands, to pass, which verify leaves to CI rather than grading it with a
 * run of the suite the pipeline no longer makes.
 */
describe("criteria left to CI", () => {
  const BODY = "- [ ] it works\n- [ ] the checks pass\n";
  const LEFT_TO_CI = verdictResult([
    { text: "it works", status: "met", evidence: "ran it" },
    { text: "the checks pass", status: "ci", evidence: "ci.yml runs npm test and npm run typecheck" },
  ]);
  const ONLY_CI = verdictResult([
    { text: "the checks pass", status: "ci", evidence: "ci.yml runs npm test and npm run typecheck" },
  ]);

  it("pass the verdict, and the verify row and the Run's line count them apart", async () => {
    tracker.issue(TICKET).body = BODY;
    runner.queue("verify", { result: LEFT_TO_CI });

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(progressTable()).toContain("| verify | ✅ 1 met · 1 to CI | 7 | 1s |");
    expect(logged).toContain(`#${TICKET} verified · 1 met · 1 to CI`);
  });

  it("are ticked by the merge once CI passes, as a met one is", async () => {
    tracker.issue(TICKET).body = BODY;
    runner.queue("verify", { result: LEFT_TO_CI });

    await run();

    expect(tracker.issue(TICKET).body).toBe("- [x] it works\n- [x] the checks pass\n");
    expect(tracker.pullRequest(100).squashCommit?.body).not.toContain("Unverified:");
  });

  it("merge a Ticket whose every criterion was left to CI once CI passes, ticking them", async () => {
    ticketReads("the checks pass");
    runner.queue("verify", { result: ONLY_CI });

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(progressTable()).toContain("| verify | ✅ 0 met · 1 to CI |");
    expect(tracker.issue(TICKET).body).toBe("- [x] the checks pass");
  });

  it.each([
    ["no checks", true, "⚠️ no checks"],
    ["no workflow runs", false, "⚠️ no workflow runs"],
  ])("stay unticked and are named unverified when CI ends in %s", async (_, canRun, row) => {
    if (!canRun) workspace.workflows = [];
    tracker.ci = { state: "none" };
    tracker.issue(TICKET).body = BODY;
    runner.queue("verify", { result: LEFT_TO_CI });

    expect(await run()).toMatchObject({ outcome: "merged" });
    expect(progressTable()).toContain(`| ci | ${row} |`);
    expect(tracker.issue(TICKET).body).toBe("- [x] it works\n- [ ] the checks pass\n");
    expect(tracker.pullRequest(100).squashCommit?.body).toContain(
      "Unverified:\n- the checks pass — ci.yml runs npm test and npm run typecheck (left to CI, which ran no check on the pull request)",
    );
  });

  it("are named among the unverifiable criteria a Target that merges by hand is told of, when no CI ran", async () => {
    tracker.ci = { state: "none" };
    tracker.issue(TICKET).body = BODY;
    runner.queue("verify", { result: LEFT_TO_CI });

    expect(await run({ merge: false })).toMatchObject({ outcome: "handed-off", stage: "merge" });
    const [comment] = tracker.comments.filter(({ body }) => body.startsWith(HANDOFF_MARKER));
    expect(comment?.body).toContain("**Unverifiable criteria:**");
    expect(comment?.body).toContain("- the checks pass — ci.yml runs npm test and npm run typecheck");
  });

  it("hand a Ticket with no met criterion off at ci when no CI ran, saying nothing has evidence to merge on", async () => {
    ticketReads("the checks pass");
    tracker.ci = { state: "none" };
    runner.queue("verify", { result: ONLY_CI });

    const outcome = await run();

    expect(outcome).toMatchObject({ outcome: "handed-off", stage: "ci" });
    expect(tracker.calls).not.toContain("squashMerge:100");
    expect(runner.stages()).not.toContain("fix");
    expect(handoffBody()).toMatch(/no criterion has evidence to merge on/);
    expect(handoffBody()).toContain("the checks pass");
    expect(tracker.issue(TICKET).body).toBe("- [ ] the checks pass");
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
    tracker.issue(TICKET).comments.push({ id: "77", body: `Brief:\n\n${MIXED_BODY}` });

    await run();

    expect(tracker.updatedComments).toContainEqual({
      id: "77",
      body: "Brief:\n\n- [x] it works\n- [ ] the docs say so\n",
    });
  });

  it("ticks nothing, and says so, for a met criterion whose line was reworded after verify got it", async () => {
    runner.leaves("verify", () => {
      tracker.issue(TICKET).body = "- [ ] it works, reworded\n- [ ] the docs say so\n";
    });

    expect(await run()).toMatchObject({ outcome: "merged" });

    expect(tracker.calls).not.toContain(`updateIssueBody:${TICKET}`);
    expect(logged).toContain(
      `#${TICKET} ticked 0 of 1 met criteria; left unticked: criterion 1, which no unticked line reads as any more`,
    );
  });

  it("ticks nothing until the Ticket has actually merged", async () => {
    tracker.ci = RED_CI;

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
  /** A passing verdict with Notes beside it, as a verify session emits one. */
  const verdictWithNotes = (notes: unknown[]) =>
    stageResult({ result: { ...PASSING_VERDICT, notes } });

  beforeEach(() => {
    tracker.addIssue({ number: OTHER, title: "Progress comment" });
  });

  it("posts a Note on the Ticket it names", async () => {
    runner.queue("implement", noteResult([{ ticket: OTHER, summary: "the help drifts" }]));

    await run();

    expect(tracker.comments).toContainEqual({
      issue: OTHER,
      body: "<!-- ticket-runner:note -->\nFrom #2 implement\n\n**the help drifts**\n",
    });
  });

  it("comments a Note that names no Ticket on the standing Notes issue", async () => {
    runner.queue("implement", noteResult([{ summary: "Nothing cleans up worktrees." }]));

    await run();

    expect(tracker.createdIssues).toHaveLength(1);
    expect(tracker.createdIssues[0]).toMatchObject({
      title: "Notes from the pipeline",
      labels: ["needs-triage"],
    });
    expect(tracker.createdIssues[0]?.body).toContain("<!-- ticket-runner:notes-issue -->");
    expect(tracker.comments).toContainEqual({
      issue: 200,
      body: "<!-- ticket-runner:note -->\nFrom #2 implement\n\n**Nothing cleans up worktrees.**\n",
    });
  });

  it("tells the implement Stage which issue Notes are gathered on", async () => {
    tracker.addIssue({
      number: 50,
      title: "Notes from the pipeline",
      body: "<!-- ticket-runner:notes-issue -->\n**Notes from the pipeline.**\n",
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
    tracker.queueCi(RED_CI);
    runner.queue("implement", noteResult([{ summary: "Nothing cleans up worktrees." }]));

    await run();

    expect(runner.requests.find((request) => request.stage === "fix")?.prompt).toContain(
      "gathered on #200",
    );
  });

  it("opens it under the label this repo calls needs-triage", async () => {
    runner.queue("implement", noteResult([{ summary: "no cleanup" }]));

    await run({
      labels: { ...config().labels, needsTriage: "inbox" },
    });

    expect(tracker.createdIssues[0]?.labels).toEqual(["inbox"]);
  });

  it("escapes a checkbox so the guards never read a Note as criteria", async () => {
    runner.queue("implement", noteResult([{ ticket: OTHER, summary: "- [ ] rename the flag" }]));

    await run();

    const note = tracker.issue(OTHER).comments.at(-1)?.body as string;
    expect(note).toContain("- \\[ \\] rename the flag");
    expect(new RegExp(UNCHECKED_BOX, "m").test(note)).toBe(false);
  });

  it("reports every Note it routed, with where it went", async () => {
    runner.queue(
      "implement",
      noteResult([{ ticket: OTHER, summary: "the help drifts" }, { summary: "no cleanup" }]),
    );

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "merged",
      notes: [
        {
          origin: TICKET,
          stage: "implement",
          issue: OTHER,
          opened: false,
          summary: "the help drifts",
        },
        { origin: TICKET, stage: "implement", issue: 200, opened: true, summary: "no cleanup" },
      ],
    });
  });

  it("routes the fix Stage's Notes too", async () => {
    tracker.queueCi(RED_CI);
    runner.queue("fix", noteResult([{ ticket: OTHER, summary: "found while fixing" }]));

    const outcome = await run();

    expect(outcome).toMatchObject({
      notes: [{ origin: TICKET, stage: "fix", issue: OTHER, summary: "found while fixing" }],
    });
  });

  it("routes the verify Stage's Notes too", async () => {
    runner.queue("verify", verdictWithNotes([{ ticket: OTHER, summary: "found while grading" }]));

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "merged",
      notes: [{ origin: TICKET, stage: "verify", issue: OTHER, summary: "found while grading" }],
    });
  });

  it("sends a verify Note naming the Ticket it is grading to triage", async () => {
    runner.queue(
      "verify",
      verdictWithNotes([{ ticket: TICKET, summary: "the lock file is never read" }]),
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
      ...verdictWithNotes([{ ticket: OTHER, summary: "noticed before I ran out of turns" }]),
      ok: false,
      failure: "turn-capped",
    });

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "handed-off",
      stage: "verify",
      notes: [{ stage: "verify", issue: OTHER, summary: "noticed before I ran out of turns" }],
    });
  });

  it("routes the Notes of a verify Stage whose verdict was unusable", async () => {
    runner.queue(
      "verify",
      stageResult({ result: { notes: [{ ticket: OTHER, summary: "graded nothing, saw this" }] } }),
    );

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "handed-off",
      stage: "verify",
      notes: [{ stage: "verify", issue: OTHER, summary: "graded nothing, saw this" }],
    });
  });

  it("routes a verify Note before the worktree it was found in is cleaned", async () => {
    workspace.discardChanges = async () => {
      throw new Error("git: unable to unlink");
    };
    runner.queue("verify", verdictWithNotes([{ ticket: OTHER, summary: "noticed while grading" }]));

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "handed-off",
      notes: [{ stage: "verify", issue: OTHER, summary: "noticed while grading" }],
    });
  });

  it("merges the Ticket anyway when a verify Note reaches nowhere at all", async () => {
    tracker.createIssue = async () => {
      throw new Error("gh: connection reset");
    };
    runner.queue("verify", verdictWithNotes([{ summary: "lost" }]));

    expect(await run()).toMatchObject({ outcome: "merged", notes: [] });
  });

  it("tells the verify Stage which issue Notes are gathered on", async () => {
    tracker.addIssue({
      number: 50,
      title: "Notes from the pipeline",
      body: "<!-- ticket-runner:notes-issue -->\n**Notes from the pipeline.**\n",
      labels: ["needs-triage"],
    });

    await run();

    expect(runner.requests.find((request) => request.stage === "verify")?.prompt).toContain(
      "gathered on #50",
    );
  });

  it("routes a failed Stage's Notes before handing the Ticket off", async () => {
    runner.queue("implement", {
      ...noteResult([{ ticket: OTHER, summary: "noticed before I died" }]),
      ok: false,
      failure: "turn-capped",
    });

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "handed-off",
      stage: "implement",
      notes: [{ issue: OTHER, summary: "noticed before I died" }],
    });
  });

  it("sends a Note to triage when the Ticket it named will not take it", async () => {
    runner.queue("implement", noteResult([{ ticket: 404, summary: "the flag is wrong" }]));

    const outcome = await run();

    expect(outcome).toMatchObject({
      outcome: "merged",
      notes: [{ issue: 200, opened: true, summary: "the flag is wrong" }],
    });
  });

  it("opens one standing issue for the Notes of both its Stages", async () => {
    tracker.queueCi(RED_CI);
    runner.queue("implement", noteResult([{ summary: "worktrees leak" }]));
    runner.queue("fix", noteResult([{ summary: "so does the lock file" }]));

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
    runner.queue("implement", noteResult([{ ticket: 404, summary: "lost" }]));

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
  const SECOND_BRANCH = "agent/3";

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
      credential: "subscription",
      pluginDir: FAKE_PLUGIN_DIR,
      billing: emptyBilling(),
      baseBranch: await resolveBaseBranch(tracker, settings),
      landing: new Landing(),
      standingNotes: new StandingNotes(),
      baseChecks: new BaseBranchChecks(),
      selfHosted: false,
      transcriptHome,
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
