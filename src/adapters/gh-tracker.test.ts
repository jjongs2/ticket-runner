import { beforeEach, describe, expect, it } from "vitest";
import { GhTracker } from "./gh-tracker.js";
import type { ExecOptions, Execution } from "./exec.js";

let calls: string[][];
let responses: Execution[];

function ok(stdout: string, extra: Partial<Execution> = {}): Execution {
  return { exitCode: 0, stdout, stderr: "", output: stdout, ...extra };
}

function tracker(...queued: Execution[]) {
  return trackerWith({}, ...queued);
}

/** A tracker whose clock is whatever the test hands it; grace is off unless asked for. */
function trackerWith(
  options: { now?: () => number; checksGraceMs?: number },
  ...queued: Execution[]
) {
  responses = [...queued];
  return new GhTracker({
    run: async (_command: string, args: string[], _options: ExecOptions) => {
      calls.push(args);
      return responses.shift() ?? ok("");
    },
    sleep: async () => {},
    pollIntervalMs: 0,
    checksGraceMs: 0,
    ...options,
  });
}

beforeEach(() => {
  calls = [];
});

describe("reading", () => {
  it("asks gh who the current user is", async () => {
    expect(await tracker(ok("octocat\n")).currentUser()).toBe("octocat");
    expect(calls[0]).toEqual(["api", "user", "--jq", ".login"]);
  });

  it("lists label names", async () => {
    const labels = await tracker(ok('[{"name":"needs-triage"},{"name":"wontfix"}]')).listLabels();

    expect(labels).toEqual(["needs-triage", "wontfix"]);
    expect(calls[0]?.slice(0, 2)).toEqual(["label", "list"]);
  });

  it("flattens an issue into labels, assignees and comment bodies", async () => {
    const issue = await tracker(
      ok(
        JSON.stringify({
          number: 2,
          title: "Skeleton",
          url: "https://github.com/acme/repo/issues/2",
          body: "- [ ] it works",
          labels: [{ name: "ready-for-agent" }],
          assignees: [{ login: "octocat" }],
          comments: [{ body: "extra criteria" }],
        }),
      ),
    ).getIssue(2);

    expect(issue).toEqual({
      number: 2,
      title: "Skeleton",
      url: "https://github.com/acme/repo/issues/2",
      body: "- [ ] it works",
      labels: ["ready-for-agent"],
      assignees: ["octocat"],
      comments: ["extra criteria"],
    });
    expect(calls[0]?.slice(0, 3)).toEqual(["issue", "view", "2"]);
  });
  it("reads candidates, their assignees and their open native blockers", async () => {
    const candidates = await tracker(
      ok(
        JSON.stringify([
          {
            number: 4,
            title: "Planning guards",
            assignees: [{ login: "octocat" }],
            issue_dependencies_summary: { blocked_by: 1, total_blocked_by: 2 },
          },
          {
            number: 5,
            title: "Fix Stage",
            assignees: [],
            issue_dependencies_summary: { blocked_by: 0, total_blocked_by: 1 },
          },
        ]),
      ),
    ).listCandidates("ready-for-agent");

    expect(candidates).toEqual([
      { number: 4, title: "Planning guards", assignees: ["octocat"], openBlockers: 1 },
      { number: 5, title: "Fix Stage", assignees: [], openBlockers: 0 },
    ]);
  });

  it("refuses to read a missing dependency summary as unblocked", async () => {
    // Defaulting to zero would merge every blocked Ticket without a word.
    const listing = tracker(
      ok(JSON.stringify([{ number: 4, title: "Planning guards", assignees: [] }])),
    ).listCandidates("ready-for-agent");

    await expect(listing).rejects.toThrow(/issue_dependencies_summary/);
  });

  it("asks the API for open issues with the label, since gh issue list has no blockers", async () => {
    await tracker(ok("[]")).listCandidates("ready-for-agent");

    expect(calls[0]).toContain("repos/{owner}/{repo}/issues");
    expect(calls[0]).toContain("state=open");
    expect(calls[0]).toContain("labels=ready-for-agent");
  });

  it("drops the pull requests GitHub returns from the issue list", async () => {
    const candidates = await tracker(
      ok(
        JSON.stringify([
          { number: 12, title: "A PR", assignees: [], pull_request: { url: "..." } },
          {
            number: 5,
            title: "A Ticket",
            assignees: [],
            issue_dependencies_summary: { blocked_by: 0 },
          },
        ]),
      ),
    ).listCandidates("ready-for-agent");

    expect(candidates.map((candidate) => candidate.number)).toEqual([5]);
  });
});

describe("writing", () => {
  it("creates a label with its colour and description", async () => {
    await tracker(ok("")).createLabel({
      name: "in-progress",
      color: "1d76db",
      description: "Claimed by an agent-pipeline Run",
    });

    expect(calls[0]).toEqual([
      "label",
      "create",
      "in-progress",
      "--color",
      "1d76db",
      "--description",
      "Claimed by an agent-pipeline Run",
    ]);
  });

  it("assigns, unassigns and moves labels through gh issue edit", async () => {
    const gh = tracker(ok(""), ok(""), ok(""), ok(""));
    await gh.assign(2, "octocat");
    await gh.unassign(2, "octocat");
    await gh.addLabel(2, "in-progress");
    await gh.removeLabel(2, "ready-for-agent");

    expect(calls).toEqual([
      ["issue", "edit", "2", "--add-assignee", "octocat"],
      ["issue", "edit", "2", "--remove-assignee", "octocat"],
      ["issue", "edit", "2", "--add-label", "in-progress"],
      ["issue", "edit", "2", "--remove-label", "ready-for-agent"],
    ]);
  });

  it("comments with the body as a single argument", async () => {
    await tracker(ok("")).comment(2, "<!-- agent-pipeline:handoff -->\nline two");

    expect(calls[0]).toEqual([
      "issue",
      "comment",
      "2",
      "--body",
      "<!-- agent-pipeline:handoff -->\nline two",
    ]);
  });
});

describe("pull requests", () => {
  it("opens a PR against main and reads its number from the URL", async () => {
    const pr = await tracker(ok("https://github.com/acme/repo/pull/12\n")).createPullRequest({
      head: "agent/2-skeleton",
      title: "Skeleton (#2)",
      body: "Closes #2",
      draft: false,
    });

    expect(pr).toEqual({ number: 12, url: "https://github.com/acme/repo/pull/12" });
    expect(calls[0]).toEqual([
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      "agent/2-skeleton",
      "--title",
      "Skeleton (#2)",
      "--body",
      "Closes #2",
    ]);
  });

  it("opens a draft PR when the Ticket is being handed off", async () => {
    await tracker(ok("https://github.com/acme/repo/pull/12\n")).createPullRequest({
      head: "agent/2-skeleton",
      title: "Skeleton (#2)",
      body: "Closes #2",
      draft: true,
    });

    expect(calls[0]).toContain("--draft");
  });

  it("converts an open PR back to a draft", async () => {
    await tracker(ok("")).convertPullRequestToDraft(12);

    expect(calls[0]).toEqual(["pr", "ready", "12", "--undo"]);
  });

  it("squash-merges", async () => {
    await tracker(ok("")).squashMerge(12);

    expect(calls[0]).toEqual(["pr", "merge", "12", "--squash"]);
  });
});

describe("waiting for CI", () => {
  const checks = (...buckets: string[]) =>
    JSON.stringify(buckets.map((bucket, i) => ({ name: `check-${i}`, bucket, state: bucket })));

  it("passes once every check is in the pass bucket", async () => {
    const outcome = await tracker(ok(checks("pass", "skipping"))).waitForCi(12, 60_000);

    expect(outcome).toEqual({ state: "passed" });
    expect(calls[0]?.slice(0, 3)).toEqual(["pr", "checks", "12"]);
  });

  it("polls while checks are pending and passes when they finish", async () => {
    const outcome = await tracker(
      ok(checks("pending"), { exitCode: 8 }),
      ok(checks("pass")),
    ).waitForCi(12, 60_000);

    expect(outcome).toEqual({ state: "passed" });
    expect(calls).toHaveLength(2);
  });

  it("names the failing checks", async () => {
    const outcome = await tracker(
      ok(checks("pass", "fail"), { exitCode: 1 }),
    ).waitForCi(12, 60_000);

    expect(outcome).toEqual({ state: "failed", summary: "check-1 failed" });
  });

  it("reports a PR with no checks rather than treating it as green", async () => {
    const outcome = await tracker({
      exitCode: 1,
      stdout: "",
      stderr: "no checks reported on the 'agent/2-x' branch",
      output: "",
    }).waitForCi(12, 60_000);

    expect(outcome).toEqual({ state: "none" });
  });

  it("reports an empty check list as no checks", async () => {
    expect(await tracker(ok("[]")).waitForCi(12, 60_000)).toEqual({ state: "none" });
  });

  const noChecks = (): Execution => ({
    exitCode: 1,
    stdout: "",
    stderr: "no checks reported on the 'agent/2-x' branch",
    output: "",
  });

  /** A clock that advances by `stepMs` every time it is read. */
  const ticking = (stepMs: number) => {
    let t = 0;
    return () => (t += stepMs);
  };

  it("keeps waiting while GitHub has not registered the checks yet", async () => {
    const outcome = await trackerWith(
      { now: ticking(1_000), checksGraceMs: 120_000 },
      noChecks(),
      noChecks(),
      ok(checks("pass")),
    ).waitForCi(12, 60_000 * 30);

    expect(outcome).toEqual({ state: "passed" });
    expect(calls).toHaveLength(3);
  });

  it("reports no checks once the grace period has passed", async () => {
    const outcome = await trackerWith(
      { now: ticking(50_000), checksGraceMs: 120_000 },
      noChecks(),
      noChecks(),
      noChecks(),
      noChecks(),
    ).waitForCi(12, 60_000 * 30);

    expect(outcome).toEqual({ state: "none" });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThan(4);
  });

  it("never lets the grace period outlive the CI timeout", async () => {
    const outcome = await trackerWith(
      { now: ticking(1_000), checksGraceMs: 120_000 },
      noChecks(),
      noChecks(),
    ).waitForCi(12, 1_500);

    expect(outcome).toEqual({ state: "none" });
  });

  it("gives up when the checks stay pending past the timeout", async () => {
    const outcome = await tracker(
      ok(checks("pending"), { exitCode: 8 }),
      ok(checks("pending"), { exitCode: 8 }),
    ).waitForCi(12, 0);

    expect(outcome).toEqual({ state: "timed-out" });
    expect(calls).toHaveLength(1);
  });
});
