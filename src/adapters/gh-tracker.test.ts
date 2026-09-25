import { beforeEach, describe, expect, it } from "vitest";
import { execution, failedExecution } from "../testing/executions.js";
import type { HostKind } from "../host.js";
import { GhTracker, type GhTrackerOptions } from "./gh-tracker.js";
import type { ExecOptions, Execution, RunProcess } from "./exec.js";

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

  it("asks REST for the highest published Release of a named repository", async () => {
    const gh = tracker(
      ok(
        JSON.stringify([
          { tag_name: "v0.3.0", draft: false, prerelease: false },
          { tag_name: "v0.10.0", draft: false, prerelease: false },
          { tag_name: "v0.9.0", draft: false, prerelease: false },
        ]),
      ),
    );

    expect(await gh.latestVersionTag("acme/repo")).toBe("v0.10.0");
    expect(calls[0]).toEqual([
      "api",
      "--method",
      "GET",
      "repos/acme/repo/releases",
      "-F",
      "per_page=100",
    ]);
  });

  it("counts no draft and no pre-release as a published Version", async () => {
    const gh = tracker(
      ok(
        JSON.stringify([
          { tag_name: "v0.6.0", draft: true, prerelease: false },
          { tag_name: "v0.5.0", draft: false, prerelease: true },
          { tag_name: "v0.4.0", draft: false, prerelease: false },
        ]),
      ),
    );

    expect(await gh.latestVersionTag("acme/repo")).toBe("v0.4.0");
  });

  it("ignores a Release tagged as anything but a Version", async () => {
    const gh = tracker(
      ok(JSON.stringify([{ tag_name: "nightly", draft: false, prerelease: false }])),
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

  it("reads what GitHub calls the Target's default branch through REST", async () => {
    expect(await tracker(ok("master\n")).defaultBranch()).toBe("master");
    expect(calls[0]).toEqual(["api", "repos/{owner}/{repo}", "--jq", ".default_branch"]);
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

  it("switches on deleting a merged branch and names no other setting", async () => {
    await tracker(ok("")).enableDeleteBranchOnMerge();

    expect(calls[0]).toEqual([
      "api",
      "--method",
      "PATCH",
      "repos/{owner}/{repo}",
      "-F",
      "delete_branch_on_merge=true",
    ]);
  });

  it("reads whether a merged branch is deleted off the repository through REST", async () => {
    expect(await tracker(ok("true\n")).deletesBranchOnMerge()).toBe(true);
    expect(calls[0]).toEqual(["api", "repos/{owner}/{repo}", "--jq", ".delete_branch_on_merge"]);
  });

  it("reads a repository that keeps merged branches, or would not say, as not deleting them", async () => {
    expect(await tracker(ok("false\n")).deletesBranchOnMerge()).toBe(false);
    expect(await tracker(ok("null\n")).deletesBranchOnMerge()).toBe(false);
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

  it("reports a label it made as created", async () => {
    const gh = tracker(ok('{"name":"in-progress"}'));

    expect(await gh.createLabel({ name: "in-progress", color: "1d76db", description: "" })).toBe(
      true,
    );
  });

  it("takes a label GitHub refuses as already there as present, and not created", async () => {
    // GitHub seeds a new repository's default labels a few seconds after it
    // exists, so one can arrive between the listing and the create.
    const gh = tracker(
      failedExecution("gh: Validation Failed (HTTP 422)", {
        stdout:
          '{"message":"Validation Failed","errors":[{"resource":"Label","code":"already_exists","field":"name"}],"documentation_url":"https://docs.github.com/rest/issues/labels#create-a-label","status":"422"}',
      }),
    );

    expect(await gh.createLabel({ name: "wontfix", color: "cfd3d7", description: "" })).toBe(false);
  });

  it("still fails a create GitHub refused as invalid for any other reason", async () => {
    const gh = tracker(
      failedExecution("gh: Validation Failed (HTTP 422)", {
        stdout:
          '{"message":"Validation Failed","errors":[{"resource":"Label","code":"invalid","field":"color"}],"status":"422"}',
      }),
    );

    await expect(
      gh.createLabel({ name: "wontfix", color: "nope", description: "" }),
    ).rejects.toThrow(/Validation Failed/);
  });

  it("still fails a create GitHub refused outright", async () => {
    const gh = tracker(failedExecution("gh: Resource not accessible by integration (HTTP 403)"));

    await expect(
      gh.createLabel({ name: "wontfix", color: "cfd3d7", description: "" }),
    ).rejects.toThrow(/HTTP 403/);
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

  it("runs no gh subcommand that goes through GraphQL for the current user, the default branch or the merge settings", async () => {
    const gh = tracker(ok("octocat\n"), ok("main\n"), ok("{}"), ok("true\n"), ok("{}"));
    await gh.currentUser();
    await gh.defaultBranch();
    await gh.enableSquashMerge();
    await gh.deletesBranchOnMerge();
    await gh.enableDeleteBranchOnMerge();

    expect(calls.filter((args) => args[0] !== "api" || args.includes("graphql"))).toEqual([]);
  });
});

describe("pull requests", () => {
  /** A pull request as REST reports it, with whatever the test sets over it. */
  const restPullRequest = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      number: 12,
      html_url: "https://github.com/acme/repo/pull/12",
      node_id: "PR_kw12",
      draft: false,
      head: { sha: "abc123" },
      ...overrides,
    });

  const opened = (draft: boolean) =>
    tracker(ok(restPullRequest({ draft }))).createPullRequest({
      base: "main",
      head: "agent/2-skeleton",
      title: "Skeleton (#2)",
      body: "Closes #2",
      draft,
    });

  it("opens a PR against the base branch it is given through REST and reads its number off the answer", async () => {
    const pr = await opened(false);

    expect(pr).toEqual({ number: 12, url: "https://github.com/acme/repo/pull/12" });
    expect(calls[0]).toEqual([
      "api",
      "--method",
      "POST",
      "repos/{owner}/{repo}/pulls",
      "-f",
      "base=main",
      "-f",
      "head=agent/2-skeleton",
      "-f",
      "title=Skeleton (#2)",
      "-f",
      "body=Closes #2",
      "-F",
      "draft=false",
    ]);
  });

  it("opens a draft PR when the Ticket is being handed off", async () => {
    await opened(true);

    expect(calls[0]?.slice(-2)).toEqual(["-F", "draft=true"]);
  });

  it("refuses an answer it cannot read a pull request number from", async () => {
    await expect(
      tracker(ok(JSON.stringify({ message: "Validation Failed" }))).createPullRequest({
        base: "main",
        head: "agent/2-skeleton",
        title: "Skeleton (#2)",
        body: "Closes #2",
        draft: false,
      }),
    ).rejects.toThrow("could not read a pull request number");
  });

  it("rewrites the body of a PR a second pass re-graded through REST", async () => {
    await tracker(ok("{}")).updatePullRequestBody(12, "Closes #2\n\n**Verdict:** 2 met");

    expect(calls[0]).toEqual([
      "api",
      "--method",
      "PATCH",
      "repos/{owner}/{repo}/pulls/12",
      "-f",
      "body=Closes #2\n\n**Verdict:** 2 met",
    ]);
  });

  it("squash-merges through REST with the subject and body the pipeline composed", async () => {
    await tracker(ok("{}")).squashMerge(12, {
      subject: "feat(cli): add a flag",
      body: "Closes #2\n\nVerdict: 1 met · 0 unmet · 0 unverifiable\n",
    });

    expect(calls[0]).toEqual([
      "api",
      "--method",
      "PUT",
      "repos/{owner}/{repo}/pulls/12/merge",
      "-f",
      "merge_method=squash",
      "-f",
      "commit_title=feat(cli): add a flag",
      "-f",
      "commit_message=Closes #2\n\nVerdict: 1 met · 0 unmet · 0 unverifiable\n",
    ]);
  });

  describe("on a workstation", () => {
    const workstation = (...queued: Execution[]) =>
      trackerWith({ host: "workstation" }, ...queued);

    it("reads the PR's state through REST, then converts it to a draft through GraphQL", async () => {
      await workstation(ok(restPullRequest({ draft: false })), ok("{}")).convertPullRequestToDraft(12);

      expect(calls[0]).toEqual(["api", "repos/{owner}/{repo}/pulls/12"]);
      expect(calls[1]?.slice(0, 2)).toEqual(["api", "graphql"]);
      expect(calls[1]?.join(" ")).toContain("convertPullRequestToDraft");
      expect(calls[1]).toContain("id=PR_kw12");
    });

    it("takes a drafted PR back out of draft through GraphQL", async () => {
      await workstation(ok(restPullRequest({ draft: true })), ok("{}")).markPullRequestReady(12);

      expect(calls[1]?.slice(0, 2)).toEqual(["api", "graphql"]);
      expect(calls[1]?.join(" ")).toContain("markPullRequestReadyForReview");
      expect(calls[1]).toContain("id=PR_kw12");
    });
  });

  describe("on a cloud Host", () => {
    const cloud = (...queued: Execution[]) => trackerWith({ host: "cloud" }, ...queued);

    it("converts a PR to a draft through the proxy's own route", async () => {
      await cloud(ok(restPullRequest({ draft: false })), ok("{}")).convertPullRequestToDraft(12);

      expect(calls[1]).toEqual([
        "api",
        "--method",
        "POST",
        "repos/{owner}/{repo}/pulls/12/ccr/convert_to_draft",
      ]);
    });

    it("takes a drafted PR back out of draft through the proxy's own route", async () => {
      await cloud(ok(restPullRequest({ draft: true })), ok("{}")).markPullRequestReady(12);

      expect(calls[1]).toEqual([
        "api",
        "--method",
        "POST",
        "repos/{owner}/{repo}/pulls/12/ccr/ready_for_review",
      ]);
    });
  });

  it.each<HostKind>(["workstation", "cloud"])(
    "leaves a PR already in the state asked for as it is, on a %s",
    async (host) => {
      const gh = trackerWith(
        { host },
        ok(restPullRequest({ draft: false })),
        ok(restPullRequest({ draft: true })),
      );

      await gh.markPullRequestReady(12);
      await gh.convertPullRequestToDraft(12);

      expect(calls).toEqual([
        ["api", "repos/{owner}/{repo}/pulls/12"],
        ["api", "repos/{owner}/{repo}/pulls/12"],
      ]);
    },
  );

  it("fails a draft or ready GitHub refused rather than handing off as if it held", async () => {
    await expect(
      trackerWith(
        { host: "cloud" },
        ok(restPullRequest({ draft: false })),
        failedExecution("HTTP 404"),
      ).convertPullRequestToDraft(12),
    ).rejects.toThrow();
  });

  /** Every pull-request call of the port once, and the release list, on `host`. */
  async function everyPullRequestCall(host: HostKind) {
    const gh = trackerWith(
      { host },
      ok(restPullRequest()),
      ok("{}"),
      ok(restPullRequest({ draft: false })),
      ok("{}"),
      ok(restPullRequest({ draft: true })),
      ok("{}"),
      ok(restPullRequest()),
      ok(JSON.stringify({ name: "ci", status: "completed", conclusion: "success" })),
      ok(""),
      ok("{}"),
      ok("[]"),
    );
    await gh.createPullRequest({ base: "main", head: "b", title: "t", body: "b", draft: false });
    await gh.updatePullRequestBody(12, "b");
    await gh.convertPullRequestToDraft(12);
    await gh.markPullRequestReady(12);
    expect(await gh.waitForCi(12, 60_000)).toEqual({ state: "passed" });
    await gh.squashMerge(12, { subject: "s", body: "b" });
    await gh.latestVersionTag("acme/repo");
    expect(calls).toHaveLength(11);
  }

  /** The calls that are not `gh api` REST: another subcommand, or GraphQL. */
  const notRest = () => calls.filter((args) => args[0] !== "api" || args.includes("graphql"));

  it("runs nothing but REST for any pull-request call on a cloud Host", async () => {
    await everyPullRequestCall("cloud");

    expect(notRest()).toEqual([]);
  });

  it("runs GraphQL for draft and ready alone on a workstation", async () => {
    await everyPullRequestCall("workstation");

    expect(notRest().map((args) => args[1])).toEqual(["graphql", "graphql"]);
  });
});

describe("waiting for CI", () => {
  /** The head commit every pull request here points at. */
  const HEAD = "abc123";

  /**
   * One reading: the head commit's check runs and commit statuses, and what
   * the pull request says of merging it, as far as GitHub has worked it out.
   */
  interface Reading {
    runs?: object[];
    statuses?: object[];
    mergeable?: boolean | null;
    mergeable_state?: string;
  }

  /** What `gh --paginate --jq '.key[]'` prints: one entry per line. */
  const lines = (entries: object[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");

  /** An Actions job's check run, in the state a `gh pr checks` bucket names. */
  const run = (bucket: string, i = 0) => {
    const [status, conclusion] = {
      pass: ["completed", "success"],
      fail: ["completed", "failure"],
      cancel: ["completed", "cancelled"],
      skipping: ["completed", "skipped"],
      pending: ["in_progress", null],
    }[bucket] as [string, string | null];
    return {
      name: `check-${i}`,
      status,
      conclusion,
      details_url: `https://github.com/acme/repo/actions/runs/99/job/${100 + i}`,
      html_url: `https://github.com/acme/repo/runs/${100 + i}`,
    };
  };

  const checks = (...buckets: string[]): Reading => ({
    runs: buckets.map((bucket, i) => run(bucket, i)),
  });

  /** GitHub would not answer for the commit's checks. */
  const UNANSWERED = "unanswered" as const;

  const log = (count: number) =>
    Array.from({ length: count }, (_, i) => `step line ${i + 1}`).join("\n");

  /**
   * A `gh` answered by what each call asks for: the pull request and the head
   * commit's checks — one reading after another, taken as the pull request is
   * read, the last repeating — or a job's log out of `logs`, where a job not
   * named has none.
   */
  function answering(
    readings: (Reading | typeof UNANSWERED)[],
    logs: Record<string, Execution | Error> = {},
  ): RunProcess {
    const queue = [...readings];
    let current: Reading | typeof UNANSWERED = {};
    return async (_command: string, args: string[]) => {
      calls.push(args);
      const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (path === "repos/{owner}/{repo}/pulls/12") {
        current = (queue.length > 1 ? queue.shift() : queue[0]) ?? {};
        const mergeability =
          current === UNANSWERED
            ? {}
            : { mergeable: current.mergeable, mergeable_state: current.mergeable_state };
        return ok(JSON.stringify({ number: 12, draft: false, head: { sha: HEAD }, ...mergeability }));
      }
      if (path.endsWith("/check-runs")) {
        return current === UNANSWERED ? failedExecution("HTTP 502") : ok(lines(current.runs ?? []));
      }
      if (path.endsWith("/status")) {
        return current === UNANSWERED
          ? failedExecution("HTTP 502")
          : ok(lines(current.statuses ?? []));
      }
      const job = /actions\/jobs\/(\d+)\/logs$/.exec(path)?.[1];
      if (job !== undefined) {
        const answer = logs[job];
        if (answer instanceof Error) throw answer;
        return answer ?? failedExecution("HTTP 404");
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };
  }

  /** A tracker over {@link answering}; grace is off unless asked for. */
  function ci(
    options: GhTrackerOptions,
    readings: (Reading | typeof UNANSWERED)[],
    logs: Record<string, Execution | Error> = {},
  ) {
    return new GhTracker({
      run: answering(readings, logs),
      sleep: async () => {},
      pollIntervalMs: 0,
      checksGraceMs: 0,
      ...options,
    });
  }

  /** How many times the head commit's checks were read. */
  const readingsTaken = () => calls.filter((args) => args.some((arg) => arg.endsWith("/check-runs"))).length;

  /** What the fix Stage is told in place of check-0's log. */
  const UNAVAILABLE =
    "(the log was unavailable; the job is at https://github.com/acme/repo/actions/runs/99/job/100)";

  const excerptOf = (outcome: unknown) => (outcome as { excerpt: string }).excerpt;

  it("reads the head commit's check runs and status through REST", async () => {
    await ci({}, [checks("pass")]).waitForCi(12, 60_000);

    expect(calls).toEqual([
      ["api", "repos/{owner}/{repo}/pulls/12"],
      [
        "api",
        "--paginate",
        "--method",
        "GET",
        `repos/{owner}/{repo}/commits/${HEAD}/check-runs`,
        "-F",
        "per_page=100",
        "--jq",
        ".check_runs[]",
      ],
      [
        "api",
        "--paginate",
        "--method",
        "GET",
        `repos/{owner}/{repo}/commits/${HEAD}/status`,
        "-F",
        "per_page=100",
        "--jq",
        ".statuses[]",
      ],
    ]);
  });

  it("passes once every check is in the pass bucket", async () => {
    expect(await ci({}, [checks("pass", "skipping")]).waitForCi(12, 60_000)).toEqual({
      state: "passed",
    });
  });

  it("counts a neutral check run as skipped, not as pending", async () => {
    const neutral = { ...run("pass"), conclusion: "neutral" };

    expect(await ci({}, [{ runs: [neutral] }]).waitForCi(12, 60_000)).toEqual({ state: "passed" });
  });

  it("polls while checks are pending and passes when they finish", async () => {
    const outcome = await ci({}, [checks("pending"), checks("pass")]).waitForCi(12, 60_000);

    expect(outcome).toEqual({ state: "passed" });
    expect(readingsTaken()).toBe(2);
  });

  it("reads a head commit GitHub would not report as no checks, not as a failed wait", async () => {
    const gh = trackerWith({}, failedExecution("HTTP 502"));

    expect(await gh.waitForCi(12, 60_000)).toEqual({ state: "none" });
  });

  it.each([
    ["timed_out", "failed"],
    ["action_required", "failed"],
    ["startup_failure", "failed"],
    ["cancelled", "cancelled"],
  ])("reports a check run that concluded %s as %s", async (conclusion, word) => {
    const outcome = await ci({}, [{ runs: [{ ...run("fail"), conclusion }] }]).waitForCi(12, 60_000);

    expect(outcome).toMatchObject({ state: "failed", summary: `check-0 ${word}` });
  });

  it("counts a commit status as a check, in the same buckets", async () => {
    const status = (state: string) => ({
      context: "ci/legacy",
      state,
      target_url: "https://ci.example.com/build/1",
    });

    expect(await ci({}, [{ statuses: [status("success")] }]).waitForCi(12, 60_000)).toEqual({
      state: "passed",
    });
    expect(
      await ci({}, [{ statuses: [status("pending")] }, { statuses: [status("error")] }]).waitForCi(
        12,
        60_000,
      ),
    ).toEqual({ state: "failed", summary: "ci/legacy failed", excerpt: "" });
  });

  it("names the failing checks", async () => {
    const outcome = await ci({}, [checks("pass", "fail")], {
      "101": ok("Run tests\n##[error]assertion failed"),
    }).waitForCi(12, 60_000);

    expect(outcome).toEqual({
      state: "failed",
      summary: "check-1 failed",
      excerpt: "check-1\nRun tests\n##[error]assertion failed",
    });
  });

  it("fetches the failing check's Actions job log through REST", async () => {
    await ci({}, [checks("pass", "fail")], { "101": ok("boom") }).waitForCi(12, 60_000);

    expect(calls.at(-1)).toEqual(["api", "repos/{owner}/{repo}/actions/jobs/101/logs"]);
  });

  it("keeps the log up to the last error, not the cleanup the runner printed after it", async () => {
    const outcome = await ci({}, [checks("fail")], {
      "100": ok(
        [
          "Run npm test",
          "assertion failed",
          "##[error]Process completed with exit code 1.",
          "Post job cleanup.",
          "Cleaning up orphan processes",
        ].join("\n"),
      ),
    }).waitForCi(12, 60_000);

    expect(excerptOf(outcome)).toBe(
      "check-0\nRun npm test\nassertion failed\n##[error]Process completed with exit code 1.",
    );
  });

  it("keeps the tail of a long log and says how much it dropped", async () => {
    const outcome = await ci({}, [checks("fail")], { "100": ok(log(60)) }).waitForCi(12, 60_000);

    const excerpt = excerptOf(outcome);
    expect(excerpt).toContain("(20 earlier lines omitted)");
    expect(excerpt).toContain("step line 60");
    expect(excerpt).not.toContain("step line 20\n");
    expect(excerpt.split("\n")).toHaveLength(42);
  });

  it("does not say it dropped anything from a log that fits", async () => {
    const outcome = await ci({}, [checks("fail")], { "100": ok(log(3)) }).waitForCi(12, 60_000);

    expect(excerptOf(outcome)).toBe(`check-0\n${log(3)}`);
  });

  it("still reports the failure when the check is not an Actions job", async () => {
    const vercel = {
      name: "vercel",
      status: "completed",
      conclusion: "failure",
      details_url: "https://vercel.com/x/y",
    };
    const outcome = await ci({}, [{ runs: [vercel] }]).waitForCi(12, 60_000);

    expect(outcome).toEqual({ state: "failed", summary: "vercel failed", excerpt: "" });
    expect(calls.some((args) => args.some((arg) => arg.includes("/logs")))).toBe(false);
  });

  it("carries on without the log when it cannot be fetched, naming where the job is", async () => {
    const outcome = await ci({}, [checks("fail")], {
      "100": failedExecution("HTTP 403: host not allowed"),
    }).waitForCi(12, 60_000);

    expect(outcome).toEqual({
      state: "failed",
      summary: "check-0 failed",
      excerpt: `check-0\n${UNAVAILABLE}`,
    });
  });

  it("carries on without the log when fetching it throws", async () => {
    const outcome = await ci({}, [checks("fail")], { "100": new Error("spawn gh ENOENT") }).waitForCi(
      12,
      60_000,
    );

    expect(excerptOf(outcome)).toContain("the log was unavailable");
  });

  it("calls an empty log unavailable too", async () => {
    const outcome = await ci({}, [checks("cancel")], { "100": ok("") }).waitForCi(12, 60_000);

    expect(outcome).toEqual({
      state: "failed",
      summary: "check-0 cancelled",
      excerpt: `check-0\n${UNAVAILABLE}`,
    });
  });

  it("fetches the Actions job's log past checks that have none", async () => {
    const external = (name: string) => ({
      name,
      status: "completed",
      conclusion: "failure",
      details_url: `https://${name}.example.com/x/y`,
    });
    const outcome = await ci(
      {},
      [
        {
          runs: [
            external("vercel"),
            external("codecov"),
            external("netlify"),
            {
              ...run("fail"),
              name: "build",
              details_url: "https://github.com/acme/repo/actions/runs/99/job/7",
            },
          ],
        },
      ],
      { "7": ok("boom") },
    ).waitForCi(12, 60_000);

    expect(excerptOf(outcome)).toBe("build\nboom");
  });

  it("keeps the tail of one line too long to carry whole", async () => {
    const outcome = await ci({}, [checks("fail")], {
      "100": ok(`${"x".repeat(5_000)}assertion failed`),
    }).waitForCi(12, 60_000);

    const excerpt = excerptOf(outcome);
    expect(excerpt).toContain("(the start of this line omitted)");
    expect(excerpt).toMatch(/assertion failed$/);
    expect(excerpt.length).toBeLessThan(4_100);
  });

  it("caps how many failing jobs it fetches a log for", async () => {
    const outcome = await ci({}, [checks("fail", "fail", "fail", "fail")], {
      "100": ok("first"),
      "101": ok("second"),
      "102": ok("third"),
      "103": ok("fourth"),
    }).waitForCi(12, 60_000);

    expect(excerptOf(outcome)).not.toContain("fourth");
    expect(calls.filter((args) => args.some((arg) => arg.endsWith("/logs")))).toHaveLength(3);
  });

  it("never fetches a log while the checks are still pending", async () => {
    await ci({}, [checks("pending"), checks("fail")], { "100": ok("boom") }).waitForCi(12, 60_000);

    const logFetches = calls.flatMap((args, i) => (args.some((arg) => arg.endsWith("/logs")) ? [i] : []));
    expect(logFetches).toEqual([calls.length - 1]);
    expect(readingsTaken()).toBe(2);
  });

  it("reports a PR with no checks rather than treating it as green", async () => {
    expect(await ci({}, [{}]).waitForCi(12, 60_000)).toEqual({ state: "none" });
  });

  it("reads checks GitHub would not report as none", async () => {
    expect(await ci({}, [UNANSWERED]).waitForCi(12, 60_000)).toEqual({ state: "none" });
  });

  it("refuses check output it cannot read", async () => {
    const gh = trackerWith(
      {},
      ok(JSON.stringify({ number: 12, head: { sha: HEAD } })),
      ok("not json"),
      ok(""),
    );

    await expect(gh.waitForCi(12, 60_000)).rejects.toThrow("could not read the check_runs");
  });

  /** A clock that advances by `stepMs` every time it is read. */
  const ticking = (stepMs: number) => {
    let t = 0;
    return () => (t += stepMs);
  };

  it("keeps waiting while GitHub has not registered the checks yet", async () => {
    const outcome = await ci({ now: ticking(1_000), checksGraceMs: 120_000 }, [
      {},
      {},
      checks("pass"),
    ]).waitForCi(12, 60_000 * 30);

    expect(outcome).toEqual({ state: "passed" });
    expect(readingsTaken()).toBe(3);
  });

  it("reports no checks once the grace period has passed", async () => {
    const outcome = await ci({ now: ticking(50_000), checksGraceMs: 120_000 }, [{}]).waitForCi(
      12,
      60_000 * 30,
    );

    expect(outcome).toEqual({ state: "none" });
    expect(readingsTaken()).toBeGreaterThan(1);
    expect(readingsTaken()).toBeLessThan(4);
  });

  /** What GitHub says of a pull request that conflicts with its base. */
  const CONFLICTING = { mergeable: false, mergeable_state: "dirty" } as const;

  /** What GitHub says of a pull request whose mergeability it has not worked out yet. */
  const UNSETTLED = { mergeable: null, mergeable_state: "unknown" } as const;

  it("reports a PR GitHub finds conflicting without waiting out the grace period", async () => {
    const outcome = await ci({ now: ticking(1_000), checksGraceMs: 120_000 }, [
      CONFLICTING,
    ]).waitForCi(12, 60_000 * 30);

    expect(outcome).toEqual({ state: "conflicting" });
    expect(readingsTaken()).toBe(1);
  });

  it("keeps waiting while GitHub has not worked out whether the PR conflicts", async () => {
    const outcome = await ci({ now: ticking(1_000), checksGraceMs: 120_000 }, [
      UNSETTLED,
      UNSETTLED,
      CONFLICTING,
    ]).waitForCi(12, 60_000 * 30);

    expect(outcome).toEqual({ state: "conflicting" });
    expect(readingsTaken()).toBe(3);
  });

  it("reports no checks for a PR GitHub never settled on, once the grace period has passed", async () => {
    const outcome = await ci({ now: ticking(50_000), checksGraceMs: 120_000 }, [
      UNSETTLED,
    ]).waitForCi(12, 60_000 * 30);

    expect(outcome).toEqual({ state: "none" });
  });

  it("reports no checks for a PR that merges cleanly", async () => {
    const outcome = await ci({ now: ticking(50_000), checksGraceMs: 120_000 }, [
      { mergeable: true, mergeable_state: "clean" },
    ]).waitForCi(12, 60_000 * 30);

    expect(outcome).toEqual({ state: "none" });
    expect(readingsTaken()).toBeGreaterThan(1);
  });

  it("reads the checks of a PR that has them, conflicting or not", async () => {
    expect(await ci({}, [{ ...checks("pass"), ...CONFLICTING }]).waitForCi(12, 60_000)).toEqual({
      state: "passed",
    });
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
    const outcome = await ci(
      { ...waitingClock(), pollIntervalMs: 60_000, checksGraceMs: 5 * 60_000 },
      [{}, {}, {}, {}, checks("pass")],
    ).waitForCi(12, 60_000 * 30);

    expect(outcome).toEqual({ state: "passed" });
    expect(readingsTaken()).toBe(5);
  });

  it("falls back to a five-minute grace when the caller sets none", async () => {
    const outcome = await new GhTracker({
      run: answering([{}]),
      ...waitingClock(),
      pollIntervalMs: 120_000,
    }).waitForCi(12, 60_000 * 30);

    // The sixth minute is past the grace; the fourth reading is the first to be
    // taken there, so it is the one reported rather than waited out.
    expect(outcome).toEqual({ state: "none" });
    expect(readingsTaken()).toBe(4);
  });

  it("never lets the grace period outlive the CI timeout", async () => {
    const outcome = await ci({ now: ticking(1_000), checksGraceMs: 120_000 }, [{}]).waitForCi(
      12,
      1_500,
    );

    expect(outcome).toEqual({ state: "none" });
  });

  it("gives up when the checks stay pending past the timeout", async () => {
    const outcome = await ci({}, [checks("pending")]).waitForCi(12, 0);

    expect(outcome).toEqual({ state: "timed-out" });
    expect(readingsTaken()).toBe(1);
  });
});
