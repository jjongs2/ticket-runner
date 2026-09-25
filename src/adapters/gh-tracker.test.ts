import { beforeEach, describe, expect, it } from "vitest";
import { execution, failedExecution } from "../testing/executions.js";
import { GhTracker, type GhTrackerOptions } from "./gh-tracker.js";
import type { ExecOptions, Execution } from "./exec.js";

let calls: string[][];
let responses: Execution[];

/** A `gh` call that succeeded, printing `stdout`. */
function ok(stdout: string, extra: Partial<Execution> = {}): Execution {
  return execution({ stdout, ...extra });
}

/** One issue as the REST API reports it, with whatever the test sets over it. */
function restIssue(overrides: Record<string, unknown> = {}) {
  return {
    number: 2,
    title: "Skeleton",
    html_url: "https://github.com/acme/repo/issues/2",
    body: "- [ ] it works",
    state: "open",
    labels: [],
    assignees: [],
    sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
    ...overrides,
  };
}

/** What REST answers an assignment with: the issue, wearing `login`. */
function assigned(login: string): string {
  return JSON.stringify(restIssue({ assignees: [{ login }] }));
}

function tracker(...queued: Execution[]) {
  return trackerWith({}, ...queued);
}

/** A tracker whose clock is whatever the test hands it; grace is off unless asked for. */
function trackerWith(options: GhTrackerOptions, ...queued: Execution[]) {
  return ghTracker({ checksGraceMs: 0, ...options }, ...queued);
}

/**
 * A tracker whose `gh` calls are recorded and answered from `queued` in order.
 * Nothing but those stubs is set, so the adapter's own defaults stand — which is
 * what a test of the grace default wants, and why `trackerWith` turns it off.
 */
function ghTracker(options: GhTrackerOptions, ...queued: Execution[]) {
  responses = [...queued];
  return new GhTracker({
    run: async (_command: string, args: string[], _options: ExecOptions) => {
      calls.push(args);
      return responses.shift() ?? ok("");
    },
    sleep: async () => {},
    pollIntervalMs: 0,
    ...options,
  });
}

beforeEach(() => {
  calls = [];
});

describe("reading", () => {
  it("reads authentication off asking REST for the current user", async () => {
    expect(await tracker(ok("octocat\n")).authenticated()).toBe(true);
    expect(calls[0]).toEqual(["api", "user", "--jq", ".login"]);
  });

  it("answers that gh is not authenticated rather than throwing", async () => {
    const gh = tracker(failedExecution("gh: Bad credentials (HTTP 401)"));

    expect(await gh.authenticated()).toBe(false);
  });
  it("answers that gh is not authenticated when gh itself cannot be run", async () => {
    const gh = trackerWith({
      run: async () => {
        throw new Error("spawn gh ENOENT");
      },
    });

    expect(await gh.authenticated()).toBe(false);
  });

  it("asks gh for the highest published Release of a named repository", async () => {
    const gh = tracker(
      ok(
        JSON.stringify([
          { tagName: "v0.3.0", isDraft: false, isPrerelease: false },
          { tagName: "v0.10.0", isDraft: false, isPrerelease: false },
          { tagName: "v0.9.0", isDraft: false, isPrerelease: false },
        ]),
      ),
    );

    expect(await gh.latestVersionTag("acme/repo")).toBe("v0.10.0");
    expect(calls[0]).toEqual([
      "release",
      "list",
      "--repo",
      "acme/repo",
      "--json",
      "tagName,isDraft,isPrerelease",
      "--limit",
      "100",
    ]);
  });

  it("counts no draft and no pre-release as a published Version", async () => {
    const gh = tracker(
      ok(
        JSON.stringify([
          { tagName: "v0.6.0", isDraft: true, isPrerelease: false },
          { tagName: "v0.5.0", isDraft: false, isPrerelease: true },
          { tagName: "v0.4.0", isDraft: false, isPrerelease: false },
        ]),
      ),
    );

    expect(await gh.latestVersionTag("acme/repo")).toBe("v0.4.0");
  });

  it("ignores a Release tagged as anything but a Version", async () => {
    const gh = tracker(
      ok(JSON.stringify([{ tagName: "nightly", isDraft: false, isPrerelease: false }])),
    );

    expect(await gh.latestVersionTag("acme/repo")).toBeUndefined();
  });

  it("answers with nothing for a repository that has published none", async () => {
    expect(await tracker(ok("[]")).latestVersionTag("acme/repo")).toBeUndefined();
  });

  /**
   * Nothing the caller does with this may stop a Run, so every way of failing
   * is the same answer: no answer.
   */
  it("answers with nothing rather than throwing when gh fails", async () => {
    expect(await tracker(failedExecution("HTTP 404")).latestVersionTag("acme/repo")).toBeUndefined();
  });

  it("answers with nothing when gh itself cannot be run", async () => {
    const gh = trackerWith({
      run: async () => {
        throw new Error("spawn gh ENOENT");
      },
    });

    expect(await gh.latestVersionTag("acme/repo")).toBeUndefined();
  });

  it("answers with nothing when gh prints something that is not JSON", async () => {
    expect(await tracker(ok("not json")).latestVersionTag("acme/repo")).toBeUndefined();
  });

  it("asks gh who the current user is", async () => {
    expect(await tracker(ok("octocat\n")).currentUser()).toBe("octocat");
    expect(calls[0]).toEqual(["api", "user", "--jq", ".login"]);
  });

  it("asks gh what GitHub calls the Target's default branch", async () => {
    expect(await tracker(ok("master\n")).defaultBranch()).toBe("master");
    expect(calls[0]).toEqual([
      "repo",
      "view",
      "--json",
      "defaultBranchRef",
      "--jq",
      ".defaultBranchRef.name",
    ]);
  });

  it("refuses an empty answer rather than branching from nothing", async () => {
    await expect(tracker(ok("\n")).defaultBranch()).rejects.toThrow(/no default branch/);
  });

  it("lists label names through REST, every page of them", async () => {
    const labels = await tracker(ok('[{"name":"needs-triage"},{"name":"wontfix"}]')).listLabels();

    expect(labels).toEqual(["needs-triage", "wontfix"]);
    expect(calls[0]).toEqual([
      "api",
      "--paginate",
      "--method",
      "GET",
      "repos/{owner}/{repo}/labels",
      "-F",
      "per_page=100",
    ]);
  });

  it("flattens an issue into labels, assignees, comment bodies and relations", async () => {
    const issue = await tracker(
      ok(JSON.stringify(restIssue({ labels: [{ name: "ready-for-agent" }], assignees: [{ login: "octocat" }] }))),
      ok(JSON.stringify([{ id: 5714903734, body: "extra criteria" }])),
      ok(JSON.stringify([restIssue({ number: 3 }), restIssue({ number: 7, state: "closed" })])),
    ).getIssue(2);

    expect(issue).toEqual({
      number: 2,
      title: "Skeleton",
      url: "https://github.com/acme/repo/issues/2",
      body: "- [ ] it works",
      closed: false,
      labels: ["ready-for-agent"],
      assignees: ["octocat"],
      comments: [{ id: "5714903734", body: "extra criteria" }],
      subIssues: 0,
      blockedBy: [3, 7],
    });
  });

  it("reads an issue, its comments and its blockers through REST alone", async () => {
    await tracker(ok(JSON.stringify(restIssue())), ok("[]"), ok("[]")).getIssue(2);

    expect(calls).toEqual([
      ["api", "repos/{owner}/{repo}/issues/2"],
      ["api", "--paginate", "--method", "GET", "repos/{owner}/{repo}/issues/2/comments", "-F", "per_page=100"],
      [
        "api",
        "--paginate",
        "--method",
        "GET",
        "repos/{owner}/{repo}/issues/2/dependencies/blocked_by",
        "-F",
        "per_page=100",
      ],
    ]);
  });

  it("reports an issue GitHub calls closed as closed", async () => {
    const issue = await tracker(
      ok(JSON.stringify(restIssue({ state: "closed" }))),
      ok("[]"),
      ok("[]"),
    ).getIssue(2);

    expect(issue.closed).toBe(true);
  });

  it("reads an issue with no body as an empty one", async () => {
    const issue = await tracker(
      ok(JSON.stringify(restIssue({ body: null }))),
      ok(JSON.stringify([{ id: 99, body: null }])),
      ok("[]"),
    ).getIssue(2);

    expect(issue.body).toBe("");
    expect(issue.comments).toEqual([{ id: "99", body: "" }]);
  });

  it("reads an issue whose comment came back with no id, since the bodies still grade it", async () => {
    const issue = await tracker(
      ok(JSON.stringify(restIssue())),
      ok(JSON.stringify([{ body: "- [ ] it works" }])),
      ok("[]"),
    ).getIssue(2);

    expect(issue.comments).toEqual([{ body: "- [ ] it works" }]);
  });

  it("reads a Spec off its sub-issue count", async () => {
    const issue = await tracker(
      ok(JSON.stringify(restIssue({ sub_issues_summary: { total: 3, completed: 0 } }))),
      ok("[]"),
      ok("[]"),
    ).getIssue(2);

    expect(issue.subIssues).toBe(3);
  });

  it("refuses to read a missing sub-issue summary as a Ticket with no sub-issues", async () => {
    // Guessing zero here would offer every Spec to an implement Stage.
    const issue = tracker(
      ok(JSON.stringify(restIssue({ sub_issues_summary: undefined }))),
      ok("[]"),
      ok("[]"),
    ).getIssue(2);

    await expect(issue).rejects.toThrow(/without sub_issues_summary.total/);
  });

  it("refuses to read an issue whose blockers GitHub would not list", async () => {
    // A 404 from a GitHub without dependencies is no answer, not an empty list.
    const issue = tracker(
      ok(JSON.stringify(restIssue())),
      ok("[]"),
      failedExecution("gh: Not Found (HTTP 404)"),
    ).getIssue(2);

    await expect(issue).rejects.toThrow(/HTTP 404/);
  });

  it("reads candidates, their assignees and their open native blockers", async () => {
    const candidates = await tracker(
      ok(
        JSON.stringify([
          restIssue({ number: 4, title: "Planning guards", assignees: [{ login: "octocat" }] }),
          restIssue({ number: 5, title: "Fix Stage" }),
        ]),
      ),
      ok(JSON.stringify([restIssue({ number: 1 }), restIssue({ number: 2, state: "closed" })])),
      ok(JSON.stringify([restIssue({ number: 3, state: "closed" })])),
    ).listCandidates("ready-for-agent");

    expect(candidates).toEqual([
      { number: 4, title: "Planning guards", assignees: ["octocat"], openBlockers: 1 },
      { number: 5, title: "Fix Stage", assignees: [], openBlockers: 0 },
    ]);
  });

  it("counts blockers off each candidate's dependency list, not its summary counts", async () => {
    // The summary lags the list: a blocker added a moment ago is in the list
    // while the summary still counts none.
    const candidates = await tracker(
      ok(
        JSON.stringify([
          restIssue({
            number: 5,
            issue_dependencies_summary: { blocked_by: 0, total_blocked_by: 0 },
          }),
        ]),
      ),
      ok(JSON.stringify([restIssue({ number: 3 })])),
    ).listCandidates("ready-for-agent");

    expect(candidates[0]?.openBlockers).toBe(1);
    expect(calls[1]).toContain("repos/{owner}/{repo}/issues/5/dependencies/blocked_by");
  });

  it("counts a blocker whose state did not come back as open", async () => {
    // Reading it as closed would put a blocked Ticket on the Frontier (ADR-0003).
    const candidates = await tracker(
      ok(JSON.stringify([restIssue({ number: 5 })])),
      ok(JSON.stringify([{ number: 3 }])),
    ).listCandidates("ready-for-agent");

    expect(candidates[0]?.openBlockers).toBe(1);
  });

  it("asks the API for open issues with the label", async () => {
    await tracker(ok("[]")).listCandidates("ready-for-agent");

    expect(calls[0]).toEqual([
      "api",
      "--paginate",
      "--method",
      "GET",
      "repos/{owner}/{repo}/issues",
      "-F",
      "per_page=100",
      "-f",
      "state=open",
      "-f",
      "labels=ready-for-agent",
    ]);
  });

  it("drops the pull requests GitHub returns from the issue list", async () => {
    const candidates = await tracker(
      ok(
        JSON.stringify([
          restIssue({ number: 12, title: "A PR", pull_request: { url: "..." } }),
          restIssue({ number: 5, title: "A Ticket" }),
        ]),
      ),
      ok("[]"),
    ).listCandidates("ready-for-agent");

    expect(candidates.map((candidate) => candidate.number)).toEqual([5]);
    // No pull request's blockers are asked for either.
    expect(calls).toHaveLength(2);
  });
});

describe("writing", () => {
  it("enables squash merging and names no other merge setting", async () => {
    await tracker(ok("")).enableSquashMerge();

    expect(calls[0]).toEqual([
      "api",
      "--method",
      "PATCH",
      "repos/{owner}/{repo}",
      "-F",
      "allow_squash_merge=true",
    ]);
    expect(calls[0]?.join(" ")).not.toMatch(/merge_commit|rebase_merge|delete_branch/);
  });

  it("creates a label with its colour and description through REST", async () => {
    await tracker(ok("{}")).createLabel({
      name: "in-progress",
      color: "1d76db",
      description: "Claimed by an agent-pipeline Run",
    });

    expect(calls[0]).toEqual([
      "api",
      "--method",
      "POST",
      "repos/{owner}/{repo}/labels",
      "-f",
      "name=in-progress",
      "-f",
      "color=1d76db",
      "-f",
      "description=Claimed by an agent-pipeline Run",
    ]);
  });

  it("assigns, unassigns and moves labels through REST", async () => {
    const gh = tracker(ok(assigned("octocat")), ok("{}"), ok("[]"), ok("[]"));
    await gh.assign(2, "octocat");
    await gh.unassign(2, "octocat");
    await gh.addLabel(2, "in-progress");
    await gh.removeLabel(2, "ready-for-agent");

    expect(calls).toEqual([
      ["api", "--method", "POST", "repos/{owner}/{repo}/issues/2/assignees", "-f", "assignees[]=octocat"],
      ["api", "--method", "DELETE", "repos/{owner}/{repo}/issues/2/assignees", "-f", "assignees[]=octocat"],
      ["api", "--method", "POST", "repos/{owner}/{repo}/issues/2/labels", "-f", "labels[]=in-progress"],
      ["api", "--method", "DELETE", "repos/{owner}/{repo}/issues/2/labels/ready-for-agent"],
    ]);
  });

  it("refuses an assignment GitHub answered with success but did not make", async () => {
    // A user who cannot be assigned is dropped without an error by REST.
    const gh = tracker(ok(JSON.stringify(restIssue({ assignees: [] }))));

    await expect(gh.assign(2, "octocat")).rejects.toThrow(/did not assign octocat to #2/);
  });

  it("takes an assignment GitHub reports under the login's own capitals", async () => {
    await expect(tracker(ok(assigned("OctoCat"))).assign(2, "octocat")).resolves.toBeUndefined();
  });

  it("names a label with spaces in the path it removes it by", async () => {
    await tracker(ok("[]")).removeLabel(2, "needs triage");

    expect(calls[0]?.at(-1)).toBe("repos/{owner}/{repo}/issues/2/labels/needs%20triage");
  });

  it("takes a label the issue does not wear as already removed", async () => {
    // `gh issue edit --remove-label` was a no-op there, and a Ticket must not
    // fail over a label somebody took off first.
    const gh = tracker(failedExecution("gh: Label does not exist (HTTP 404)"));

    await expect(gh.removeLabel(2, "ready-for-agent")).resolves.toBeUndefined();
  });

  it("still fails a removal GitHub refused for any other reason", async () => {
    const gh = tracker(failedExecution("gh: Not Found (HTTP 404)"));

    await expect(gh.removeLabel(2, "ready-for-agent")).rejects.toThrow(/Not Found/);
  });

  it("comments through REST with the body as a single field", async () => {
    await tracker(ok('{"id":99}')).comment(2, "<!-- agent-pipeline:handoff -->\nline two");

    expect(calls[0]).toEqual([
      "api",
      "--method",
      "POST",
      "repos/{owner}/{repo}/issues/2/comments",
      "-f",
      "body=<!-- agent-pipeline:handoff -->\nline two",
    ]);
  });

  it("reports the id of the comment it just posted, for editing later", async () => {
    const posted = await tracker(
      ok(JSON.stringify({ id: 5714903734, body: "<!-- agent-pipeline:progress -->" })),
    ).comment(2, "<!-- agent-pipeline:progress -->");

    expect(posted).toEqual({ id: "5714903734", body: "<!-- agent-pipeline:progress -->" });
  });

  it("reports a comment with no id rather than failing, since an id costs an edit only", async () => {
    expect(await tracker(ok("{}")).comment(2, "body")).toEqual({ body: "body" });
  });

  it("edits a comment in place through the REST endpoint", async () => {
    await tracker(ok("")).updateComment("5714903734", "the table, one row longer");

    expect(calls[0]).toEqual([
      "api",
      "--method",
      "PATCH",
      "repos/{owner}/{repo}/issues/comments/5714903734",
      "-f",
      "body=the table, one row longer",
    ]);
  });

  it("replaces an issue body through REST, which is where the criteria are ticked", async () => {
    await tracker(ok("{}")).updateIssueBody(2, "- [x] it works");

    expect(calls[0]).toEqual([
      "api",
      "--method",
      "PATCH",
      "repos/{owner}/{repo}/issues/2",
      "-f",
      "body=- [x] it works",
    ]);
  });

  it("opens an issue for a Note through REST and reads its number off the answer", async () => {
    const issue = await tracker(
      ok(JSON.stringify({ number: 31, html_url: "https://github.com/acme/repo/issues/31" })),
    ).createIssue({
      title: "Nothing cleans up worktrees",
      body: "From #10 implement\n\nNothing cleans up worktrees.\n",
      labels: ["needs-triage"],
    });

    expect(issue).toEqual({ number: 31, url: "https://github.com/acme/repo/issues/31" });
    expect(calls[0]).toEqual([
      "api",
      "--method",
      "POST",
      "repos/{owner}/{repo}/issues",
      "-f",
      "title=Nothing cleans up worktrees",
      "-f",
      "body=From #10 implement\n\nNothing cleans up worktrees.\n",
      "-f",
      "labels[]=needs-triage",
    ]);
  });

  it("refuses an answer it cannot read an issue number from", async () => {
    await expect(
      tracker(ok(JSON.stringify({ html_url: "https://github.com/acme/repo/issues/31" }))).createIssue({
        title: "t",
        body: "b",
        labels: [],
      }),
    ).rejects.toThrow("could not read an issue number");
  });

  it("runs no gh subcommand that goes through GraphQL for any issue-side call", async () => {
    const gh = tracker(
      ok("octocat\n"),
      ok("[]"),
      ok("{}"),
      ok(JSON.stringify(restIssue())),
      ok("[]"),
      ok("[]"),
      ok(JSON.stringify({ number: 31, html_url: "https://github.com/acme/repo/issues/31" })),
      ok("[]"),
      ok(assigned("octocat")),
      ok("{}"),
      ok("[]"),
      ok("[]"),
      ok('{"id":1}'),
      ok("{}"),
      ok("{}"),
    );
    await gh.authenticated();
    await gh.listLabels();
    await gh.createLabel({ name: "x", color: "ffffff", description: "" });
    await gh.getIssue(2);
    await gh.createIssue({ title: "t", body: "b", labels: [] });
    await gh.listCandidates("ready-for-agent");
    await gh.assign(2, "octocat");
    await gh.unassign(2, "octocat");
    await gh.addLabel(2, "x");
    await gh.removeLabel(2, "x");
    await gh.comment(2, "b");
    await gh.updateComment("1", "b");
    await gh.updateIssueBody(2, "b");

    expect(calls.filter((args) => args[0] !== "api" || args.includes("graphql"))).toEqual([]);
  });
});

describe("pull requests", () => {
  it("opens a PR against the base branch it is given and reads its number from the URL", async () => {
    const pr = await tracker(ok("https://github.com/acme/repo/pull/12\n")).createPullRequest({
      base: "main",
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

  it("refuses a last line that starts with digits but is not a URL", async () => {
    await expect(
      tracker(ok("3 files changed\n")).createPullRequest({
        base: "main",
        head: "agent/2-skeleton",
        title: "Skeleton (#2)",
        body: "Closes #2",
        draft: false,
      }),
    ).rejects.toThrow("could not read a pull request number");
  });

  it("refuses a URL whose path is not a pull request's", async () => {
    await expect(
      tracker(ok("https://github.com/acme/repo/pull/9/pull/12\n")).createPullRequest({
        base: "main",
        head: "agent/2-skeleton",
        title: "Skeleton (#2)",
        body: "Closes #2",
        draft: false,
      }),
    ).rejects.toThrow("could not read a pull request number");
  });

  it("refuses a URL the last line carries trailing text after", async () => {
    await expect(
      tracker(ok("https://github.com/acme/repo/pull/12 (draft)\n")).createPullRequest({
        base: "main",
        head: "agent/2-skeleton",
        title: "Skeleton (#2)",
        body: "Closes #2",
        draft: false,
      }),
    ).rejects.toThrow("could not read a pull request number");
  });

  it("reads the number off the last line when gh printed something before it", async () => {
    const pr = await tracker(
      ok("Creating pull request into main\nhttps://github.com/acme/repo/pull/12\n"),
    ).createPullRequest({
      base: "main",
      head: "agent/2-skeleton",
      title: "Skeleton (#2)",
      body: "Closes #2",
      draft: false,
    });

    expect(pr).toEqual({ number: 12, url: "https://github.com/acme/repo/pull/12" });
  });

  it("opens a draft PR when the Ticket is being handed off", async () => {
    await tracker(ok("https://github.com/acme/repo/pull/12\n")).createPullRequest({
      base: "main",
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

  it("takes a drafted PR back out of draft", async () => {
    await tracker(ok("")).markPullRequestReady(12);

    expect(calls[0]).toEqual(["pr", "ready", "12"]);
  });

  it("rewrites the body of a PR a second pass re-graded", async () => {
    await tracker(ok("")).updatePullRequestBody(12, "Closes #2\n\n**Verdict:** 2 met");

    expect(calls[0]).toEqual(["pr", "edit", "12", "--body", "Closes #2\n\n**Verdict:** 2 met"]);
  });

  it("squash-merges with the subject and body the pipeline composed", async () => {
    await tracker(ok("")).squashMerge(12, {
      subject: "feat(cli): add a flag",
      body: "Closes #2\n\nVerdict: 1 met · 0 unmet · 0 unverifiable\n",
    });

    expect(calls[0]).toEqual([
      "pr",
      "merge",
      "12",
      "--squash",
      "--subject",
      "feat(cli): add a flag",
      "--body",
      "Closes #2\n\nVerdict: 1 met · 0 unmet · 0 unverifiable\n",
    ]);
  });
});

describe("waiting for CI", () => {
  const checks = (...buckets: string[]) =>
    JSON.stringify(
      buckets.map((bucket, i) => ({
        name: `check-${i}`,
        bucket,
        state: bucket,
        link: `https://github.com/acme/repo/actions/runs/99/job/${100 + i}`,
      })),
    );

  const log = (lines: number) =>
    Array.from({ length: lines }, (_, i) => `step\tline ${i + 1}`).join("\n");

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
      ok("api\tRun tests\tassertion failed"),
    ).waitForCi(12, 60_000);

    expect(outcome).toEqual({
      state: "failed",
      summary: "check-1 failed",
      excerpt: "check-1\napi\tRun tests\tassertion failed",
    });
  });

  it("fetches the failed steps of the failing check's Actions job", async () => {
    await tracker(
      ok(checks("pass", "fail"), { exitCode: 1 }),
      ok("api\tRun tests\tassertion failed"),
    ).waitForCi(12, 60_000);

    expect(calls[0]).toEqual(["pr", "checks", "12", "--json", "name,bucket,state,link"]);
    expect(calls[1]).toEqual(["run", "view", "--job", "101", "--log-failed"]);
    expect(calls).toHaveLength(2);
  });

  it("keeps the tail of a long log and says how much it dropped", async () => {
    const outcome = await tracker(
      ok(checks("fail"), { exitCode: 1 }),
      ok(log(60)),
    ).waitForCi(12, 60_000);

    const excerpt = (outcome as { excerpt: string }).excerpt;
    expect(excerpt).toContain("(20 earlier lines omitted)");
    expect(excerpt).toContain("step\tline 60");
    expect(excerpt).not.toContain("step\tline 20");
    expect(excerpt.split("\n")).toHaveLength(42);
  });

  it("does not say it dropped anything from a log that fits", async () => {
    const outcome = await tracker(
      ok(checks("fail"), { exitCode: 1 }),
      ok(log(3)),
    ).waitForCi(12, 60_000);

    expect((outcome as { excerpt: string }).excerpt).toBe(
      `check-0\n${log(3)}`,
    );
  });

  it("still reports the failure when the check is not an Actions job", async () => {
    const outcome = await tracker(
      ok(
        JSON.stringify([
          { name: "vercel", bucket: "fail", state: "fail", link: "https://vercel.com/x/y" },
        ]),
        { exitCode: 1 },
      ),
    ).waitForCi(12, 60_000);

    expect(outcome).toEqual({ state: "failed", summary: "vercel failed", excerpt: "" });
    expect(calls).toHaveLength(1);
  });

  it("still reports the failure when the log cannot be fetched", async () => {
    const outcome = await tracker(
      ok(checks("fail"), { exitCode: 1 }),
      failedExecution("could not find any workflow run"),
    ).waitForCi(12, 60_000);

    expect(outcome).toEqual({ state: "failed", summary: "check-0 failed", excerpt: "" });
  });

  it("still reports the failure when fetching the log throws", async () => {
    const failing = trackerWith(
      {
        run: async (_command: string, args: string[]) => {
          calls.push(args);
          const next = responses.shift();
          if (next === undefined) throw new Error("gh: not found");
          return next;
        },
      },
      ok(checks("fail"), { exitCode: 1 }),
    );

    expect(await failing.waitForCi(12, 60_000)).toEqual({
      state: "failed",
      summary: "check-0 failed",
      excerpt: "",
    });
  });

  it("fetches the Actions job's log past checks that have none", async () => {
    const outcome = await tracker(
      ok(
        JSON.stringify([
          { name: "vercel", bucket: "fail", state: "fail", link: "https://vercel.com/x/y" },
          { name: "codecov", bucket: "fail", state: "fail", link: "https://codecov.io/x/y" },
          { name: "netlify", bucket: "fail", state: "fail", link: "https://netlify.com/x/y" },
          {
            name: "build",
            bucket: "fail",
            state: "fail",
            link: "https://github.com/acme/repo/actions/runs/99/job/7",
          },
        ]),
        { exitCode: 1 },
      ),
      ok("boom"),
    ).waitForCi(12, 60_000);

    expect((outcome as { excerpt: string }).excerpt).toBe("build\nboom");
    expect(calls[1]).toEqual(["run", "view", "--job", "7", "--log-failed"]);
  });

  it("keeps the tail of one line too long to carry whole", async () => {
    const outcome = await tracker(
      ok(checks("fail"), { exitCode: 1 }),
      ok(`${"x".repeat(5_000)}assertion failed`),
    ).waitForCi(12, 60_000);

    const excerpt = (outcome as { excerpt: string }).excerpt;
    expect(excerpt).toContain("(the start of this line omitted)");
    expect(excerpt).toMatch(/assertion failed$/);
    expect(excerpt.length).toBeLessThan(4_100);
  });

  it("reports a cancelled check as a failure, with whatever log it has", async () => {
    const outcome = await tracker(
      ok(checks("cancel"), { exitCode: 1 }),
      ok(""),
    ).waitForCi(12, 60_000);

    expect(outcome).toEqual({ state: "failed", summary: "check-0 cancelled", excerpt: "" });
  });

  it("caps how many failing jobs it fetches a log for", async () => {
    const outcome = await tracker(
      ok(checks("fail", "fail", "fail", "fail"), { exitCode: 1 }),
      ok("first"),
      ok("second"),
      ok("third"),
      ok("fourth"),
    ).waitForCi(12, 60_000);

    expect((outcome as { excerpt: string }).excerpt).not.toContain("fourth");
    expect(calls).toHaveLength(4);
  });

  it("never fetches a log while the checks are still pending", async () => {
    await tracker(
      ok(checks("pending"), { exitCode: 8 }),
      ok(checks("fail"), { exitCode: 1 }),
      ok("boom"),
    ).waitForCi(12, 60_000);

    expect(calls.map((args) => args[0])).toEqual(["pr", "pr", "run"]);
  });

  /** What `gh pr checks` says when GitHub has registered none yet. */
  const NO_CHECKS = "no checks reported on the 'agent/2-x' branch";

  it("reports a PR with no checks rather than treating it as green", async () => {
    const outcome = await tracker(failedExecution(NO_CHECKS)).waitForCi(12, 60_000);

    expect(outcome).toEqual({ state: "none" });
  });

  it("reports an empty check list as no checks", async () => {
    expect(await tracker(ok("[]")).waitForCi(12, 60_000)).toEqual({ state: "none" });
  });

  /** A clock that advances by `stepMs` every time it is read. */
  const ticking = (stepMs: number) => {
    let t = 0;
    return () => (t += stepMs);
  };

  it("keeps waiting while GitHub has not registered the checks yet", async () => {
    const outcome = await trackerWith(
      { now: ticking(1_000), checksGraceMs: 120_000 },
      failedExecution(NO_CHECKS),
      failedExecution(NO_CHECKS),
      ok(checks("pass")),
    ).waitForCi(12, 60_000 * 30);

    expect(outcome).toEqual({ state: "passed" });
    expect(calls).toHaveLength(3);
  });

  it("reports no checks once the grace period has passed", async () => {
    const outcome = await trackerWith(
      { now: ticking(50_000), checksGraceMs: 120_000 },
      failedExecution(NO_CHECKS),
      failedExecution(NO_CHECKS),
      failedExecution(NO_CHECKS),
      failedExecution(NO_CHECKS),
    ).waitForCi(12, 60_000 * 30);

    expect(outcome).toEqual({ state: "none" });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThan(4);
  });

  /** A clock that only moves when the wait sleeps, so a test's minutes are the wait's. */
  const waitingClock = () => {
    let elapsedMs = 0;
    return {
      now: () => elapsedMs,
      sleep: async (ms: number) => {
        elapsedMs += ms;
      },
    };
  };

  it("grades a PR on checks GitHub registers four minutes into the wait", async () => {
    const outcome = await ghTracker(
      { ...waitingClock(), pollIntervalMs: 60_000 },
      failedExecution(NO_CHECKS),
      failedExecution(NO_CHECKS),
      failedExecution(NO_CHECKS),
      failedExecution(NO_CHECKS),
      ok(checks("pass")),
    ).waitForCi(12, 60_000 * 30);

    expect(outcome).toEqual({ state: "passed" });
    expect(calls).toHaveLength(5);
  });

  it("falls back to a five-minute grace when the caller sets none", async () => {
    const outcome = await ghTracker(
      { ...waitingClock(), pollIntervalMs: 120_000 },
      failedExecution(NO_CHECKS),
      failedExecution(NO_CHECKS),
      failedExecution(NO_CHECKS),
      failedExecution(NO_CHECKS),
    ).waitForCi(12, 60_000 * 30);

    // The sixth minute is past the grace; the fourth reading is the first to be
    // taken there, so it is the one reported rather than waited out.
    expect(outcome).toEqual({ state: "none" });
    expect(calls).toHaveLength(4);
  });

  it("never lets the grace period outlive the CI timeout", async () => {
    const outcome = await trackerWith(
      { now: ticking(1_000), checksGraceMs: 120_000 },
      failedExecution(NO_CHECKS),
      failedExecution(NO_CHECKS),
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
