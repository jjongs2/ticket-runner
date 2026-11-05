import { describe, expect, it } from "vitest";
import { UNCHECKED_BOX } from "./acceptance-criteria.js";
import { tickCriteria } from "./criteria.js";
import { throwOnFailure } from "./adapters/exec.js";
import { MAX_TAIL_CHARS } from "./log-tail.js";
import { type Billing, emptyBilling } from "./credential.js";
import type { RunStop } from "./run.js";
import {
  HANDOFF_MARKER,
  HANDOFF_TAKEN_LINE,
  NOTES_ISSUE_MARKER,
  NOTES_ISSUE_TITLE,
  NOTE_MARKER,
  draftPullRequestBody,
  failingBaseNote,
  failingBaseSummary,
  findMarkedComment,
  findMarkedComments,
  guardComment,
  guardMarker,
  handoffComment,
  handoffTakenComment,
  isNotesIssue,
  noteComment,
  notesIssue,
  pullRequestBody,
  runSummary,
  squashCommit,
} from "./templates.js";
import { parseVerdict } from "./verdict.js";

const verdict = parseVerdict({
  criteria: [
    { text: "tests pass", status: "met", evidence: "npm test green" },
    { text: "docs updated", status: "unverifiable", evidence: "no way to tell" },
  ],
  pass: true,
});

/** The version the Run ran, which its summary is headed with. */
const VERSION = "0.4.0+331d79c";

/** Why most summaries here end: nothing left on the Frontier. */
const FRONTIER_EMPTY: RunStop = { reason: "frontier", blocked: [] };

/** The command #288's Hand-off failed on, and how it exited. */
const PULL_FAILED = "`git pull --ff-only origin main` exited 1";
/** What SSH printed for it. */
const SSH_OUTPUT = [
  "git@github.com: Permission denied (publickey).",
  "fatal: Could not read from remote repository.",
  "",
  "Please make sure you have the correct access rights",
  "and the repository exists.",
].join("\n");
/** The message that reached the hand-off, whole. */
const UNEXPECTED = `${PULL_FAILED}\n${SSH_OUTPUT}`;

/** What `gh` printed when a call to open a pull request failed. */
const GH_OUTPUT = "HTTP 502: Bad Gateway";

/**
 * The message `throwOnFailure` builds when the `gh api` call that opens a
 * pull request with this body fails.
 */
function failedPullRequest(body: string): string {
  const args = [
    "api",
    "--method",
    "POST",
    "repos/{owner}/{repo}/pulls",
    "-f",
    "base=main",
    "-f",
    "head=agent/5-x",
    "-f",
    "title=feat: x",
    "-f",
    `body=${body}`,
    "-F",
    "draft=false",
  ];
  const result = { exitCode: 1, stdout: "", stderr: GH_OUTPUT, output: GH_OUTPUT, timedOut: false };
  try {
    throwOnFailure("gh", args, result);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("throwOnFailure did not throw");
}

/** The one line such a failure is shown as, for a body whose first line is this. */
function ghFailed(bodyLine: string): string {
  return (
    "`gh api --method POST repos/{owner}/{repo}/pulls -f base=main -f head=agent/5-x " +
    `-f title=feat: x -f body=${bodyLine} … -F draft=false\` exited 1`
  );
}

/**
 * Pull request bodies a failed `gh api` call can carry, each with the first
 * line it is shown by: a plain one; one with a line of its own that ends as a
 * failed command does, as an unverifiable criterion's evidence can; and one
 * whose first line has an odd number of backticks.
 */
const GH_BODIES = [
  { case: "a plain body", body: "Closes #5\n\nWhat it does.\n\nRun `r1`\n", first: "Closes #5" },
  {
    case: "a body with a line that says how another command exited",
    body: "Closes #5\n\nWhat it does.\n\n- ❓ CLI works — No browser: `npx playwright install` exited 1\n",
    first: "Closes #5",
  },
  {
    case: "a body whose first line has an odd number of backticks",
    body: "Closes `#5\n\nWhat it does.\n",
    first: "Closes `#5",
  },
];

/** Its Evidence block: what `gh` printed, and nothing of the body. */
const GH_EVIDENCE = ["<details><summary>Evidence</summary>", "", "```", GH_OUTPUT, "```"].join("\n");

/** The fenced Evidence block a hand-off and its draft pull request both carry. */
const SSH_EVIDENCE = ["<details><summary>Evidence</summary>", "", "```", SSH_OUTPUT, "```"].join("\n");

describe("pullRequestBody", () => {
  it("starts with Closes #<n> on its own line so the merge closes the Ticket", () => {
    const body = pullRequestBody({ ticket: 2, verdict, runId: "r1", host: "workstation" });

    expect(body.split("\n")[0]).toBe("Closes #2");
  });

  it("summarises the verdict by status count", () => {
    const body = pullRequestBody({ ticket: 2, verdict, runId: "r1", host: "workstation" });

    expect(body).toContain("**Verdict:** 1 met · 0 unmet · 1 unverifiable");
  });

  it("lists every criterion, with evidence for the ones not met", () => {
    const body = pullRequestBody({ ticket: 2, verdict, runId: "r1", host: "workstation" });

    expect(body).toContain("- ✅ tests pass");
    expect(body).toContain("- ❓ docs updated — no way to tell");
  });

  it("points a workstation's reader at the Run's directory, which outlives the Run", () => {
    const body = pullRequestBody({ ticket: 2, verdict, runId: "r1", host: "workstation" });

    expect(body).toBe(
      [
        "Closes #2",
        "",
        "**Verdict:** 1 met · 0 unmet · 1 unverifiable",
        "",
        "<details><summary>Criteria</summary>",
        "",
        "- ✅ tests pass",
        "- ❓ docs updated — no way to tell",
        "",
        "</details>",
        "",
        "Run `r1` · transcripts in `.ticket-runner/runs/r1/2/`",
        "",
      ].join("\n"),
    );
  });

  it("names the Run alone on a cloud Host, whose VM goes with its session", () => {
    const body = pullRequestBody({ ticket: 2, verdict, runId: "r1", host: "cloud" });

    expect(body.endsWith("</details>\n\nRun `r1`\n")).toBe(true);
    expect(body).not.toContain("transcripts");
  });
});

describe("draftPullRequestBody", () => {
  const base = {
    ticket: 2,
    stage: "verify",
    failure: "2 criteria unmet",
    runId: "r1",
  } as const;

  it("names where the hand-off kept the transcripts on the remote", () => {
    const body = draftPullRequestBody({
      ...base,
      transcripts: { branch: "ticket-runner/state", path: "ticket-2/r1/" },
    });

    expect(body).toContain(
      "Run `r1` · transcripts in `ticket-2/r1/` on the `ticket-runner/state` branch",
    );
    expect(body).not.toContain(".ticket-runner/runs/");
  });

  it("names the Run alone when the hand-off kept no transcripts", () => {
    const body = draftPullRequestBody(base);

    expect(body.endsWith("evidence.\n\nRun `r1`\n")).toBe(true);
    expect(body).not.toContain("transcripts");
  });

  it("opens an unexpected failure with the command and how it exited, its output in Evidence", () => {
    const body = draftPullRequestBody({ ...base, stage: "rebase", failure: UNEXPECTED });

    expect(body).toContain(`**Handed off at rebase.** ${PULL_FAILED}\n\n`);
    expect(body).toContain(SSH_EVIDENCE);
  });

  it.each(GH_BODIES)("opens a GitHub failure on $case with its command and how it exited", (gh) => {
    const body = draftPullRequestBody({ ...base, stage: "pr", failure: failedPullRequest(gh.body) });

    expect(body).toContain(`**Handed off at pr.** ${ghFailed(gh.first)}\n\n`);
    expect(body).toContain(GH_EVIDENCE);
    expect(body).not.toContain("What it does.");
  });

  it("shows no evidence for a failure the pipeline gave one line", () => {
    expect(draftPullRequestBody(base)).not.toContain("<details>");
  });
});

describe("squashCommit", () => {
  const commit = () =>
    squashCommit({
      ticket: 2,
      pullRequest: 100,
      title: "feat(cli): add a flag",
      verdict,
      commits: ["feat(cli): add a flag (#2)", "docs: write it down (#2)"],
      coAuthors: [],
    });

  it("uses the pull request title as the subject and appends the pull request number as GitHub would", () => {
    expect(commit().subject).toBe("feat(cli): add a flag (#100)");
  });

  it("carries the branch's co-authors as trailers at the end of the body", () => {
    const body = squashCommit({
      ticket: 2,
      pullRequest: 100,
      title: "feat(cli): add a flag",
      verdict,
      commits: ["feat(cli): add a flag (#2)"],
      coAuthors: ["Claude Opus 5 <noreply@anthropic.com>", "Pat <pat@example.com>"],
    }).body;

    expect(body.endsWith(
      [
        "- feat(cli): add a flag (#2)",
        "",
        "Co-authored-by: Claude Opus 5 <noreply@anthropic.com>",
        "Co-authored-by: Pat <pat@example.com>",
        "",
      ].join("\n"),
    )).toBe(true);
  });

  it("opens the body with Closes, then the verdict counts, then the branch commits in order", () => {
    expect(commit().body).toBe(
      [
        "Closes #2",
        "",
        "Verdict: 1 met · 0 unmet · 1 unverifiable",
        "",
        "- feat(cli): add a flag (#2)",
        "- docs: write it down (#2)",
        "",
      ].join("\n"),
    );
  });

  it("carries no HTML and no evidence: git log renders neither", () => {
    const body = commit().body;

    expect(body).not.toContain("<");
    expect(body).not.toContain("no way to tell");
  });
});

describe("handoffComment", () => {
  const base = {
    stage: "verify" as const,
    failure: "1 criterion unmet",
    branch: "agent/2-skeleton",
    worktree: "/repo/.worktrees/ticket-2",
    evidence: "docs updated — nothing written",
  };

  it("starts with the marker line so the pipeline finds its own comment", () => {
    expect(handoffComment(base).split("\n")[0]).toBe(HANDOFF_MARKER);
  });

  it("names the stage, failure, branch and worktree", () => {
    const comment = handoffComment(base);

    expect(comment).toContain("Failed at **verify**");
    expect(comment).toContain("- Failure: 1 criterion unmet");
    expect(comment).toContain("Branch `agent/2-skeleton`");
    expect(comment).toContain("worktree `/repo/.worktrees/ticket-2`");
  });

  it("omits the worktree clause when the Ticket failed before it had one", () => {
    const { worktree, ...beforeSetup } = base;

    const comment = handoffComment(beforeSetup);

    expect(comment).toContain("- Branch `agent/2-skeleton`");
    expect(comment).not.toContain(worktree);
    expect(comment).not.toContain("worktree");
  });

  it("names the draft pull request when one was opened", () => {
    expect(handoffComment({ ...base, pullRequest: 12 })).toContain("PR #12 (draft)");
  });

  it("says the branch is on the remote when it is, where it outlives this Host", () => {
    expect(handoffComment({ ...base, onRemote: true })).toContain(
      "- Branch `agent/2-skeleton` on the remote · worktree",
    );
    expect(handoffComment(base)).not.toContain("on the remote");
  });

  it("names where the Stages' transcripts were kept, on its own line", () => {
    const comment = handoffComment({
      ...base,
      transcripts: { branch: "ticket-runner/state", path: "ticket-2/run-1/" },
    });

    expect(comment).toContain(
      "- Transcripts: `ticket-2/run-1/` on the `ticket-runner/state` branch",
    );
    expect(handoffComment(base)).not.toContain("Transcripts");
  });

  it("omits the pull request clause when no pull request exists", () => {
    expect(handoffComment(base)).not.toContain("PR #");
  });

  it("folds the evidence away in a details block", () => {
    const comment = handoffComment(base);

    expect(comment).toContain("<details><summary>Evidence</summary>");
    expect(comment).toContain("docs updated — nothing written");
  });

  it("omits the details block when there is no evidence", () => {
    expect(handoffComment({ ...base, evidence: "" })).not.toContain("<details>");
  });

  it("gives an unexpected failure one line, and its whole output in the Evidence block", () => {
    const comment = handoffComment({ ...base, stage: "rebase", failure: UNEXPECTED, evidence: "" });

    expect(comment).toContain(`- Failure: ${PULL_FAILED}\n- Branch`);
    expect(comment).toContain(SSH_EVIDENCE);
  });

  it.each(GH_BODIES)("gives a GitHub failure on $case its command and how it exited", (gh) => {
    const comment = handoffComment({
      ...base,
      stage: "pr",
      failure: failedPullRequest(gh.body),
      evidence: "",
    });

    expect(comment).toContain(`- Failure: ${ghFailed(gh.first)}\n- Branch`);
    expect(comment).toContain(GH_EVIDENCE);
    expect(comment).not.toContain("What it does.");
    expect(comment).not.toContain("playwright");
  });

  it("says so when the Ticket had already spent its fix budget", () => {
    expect(handoffComment({ ...base, fixUsed: true })).toContain(
      "Failed at **verify**, after the fix budget was used.",
    );
  });

  it("says nothing about the budget when no fix Stage ran", () => {
    expect(handoffComment(base)).toContain("Failed at **verify**.");
    expect(handoffComment(base)).not.toMatch(/fix budget/i);
  });

  describe("with the reason a Stage gave for committing nothing", () => {
    const noCommits = {
      ...base,
      stage: "fix" as const,
      failure: "the fix Stage left no new commits on the branch",
      evidence: "- it reads the feed — ADR-0003 forbids the feed",
      fixUsed: true,
      reason: "Criterion 2 needs the feed, and ADR-0003 forbids it. A human has to choose.",
    };

    it("shows it labelled as that Stage's, outside the folded Evidence block", () => {
      const comment = handoffComment(noCommits);

      const said =
        "**The fix Stage said:** Criterion 2 needs the feed, and ADR-0003 forbids it. A human has to choose.";
      expect(comment).toContain(`\n\n${said}\n\n<details>`);
      expect(comment.indexOf(said)).toBeLessThan(comment.indexOf("<details>"));
    });

    it("keeps the failure line and the evidence as they are without it", () => {
      const { reason, ...without } = noCommits;

      const comment = handoffComment(noCommits);

      expect(comment.replace(`**The fix Stage said:** ${reason}\n\n`, "")).toBe(
        handoffComment(without),
      );
      expect(comment).toContain("- Failure: the fix Stage left no new commits on the branch");
      expect(comment).toContain("- it reads the feed — ADR-0003 forbids the feed");
    });

    it("names the implement Stage when the hand-off is that Stage's", () => {
      const comment = handoffComment({
        ...base,
        stage: "implement",
        failure: "the implement Stage left no new commits on the branch",
        evidence: "",
        reason: "The Ticket asks for a file that already exists.",
      });

      expect(comment).toContain(
        "- Failure: the implement Stage left no new commits on the branch",
      );
      expect(comment).toContain(
        "**The implement Stage said:** The Ticket asks for a file that already exists.",
      );
      expect(comment).not.toContain("<details>");
    });

    it("shows nothing when there is no reason, or only a blank one", () => {
      const { reason, ...without } = noCommits;

      expect(handoffComment(without)).not.toContain("Stage said");
      expect(handoffComment({ ...without, reason: " \n " })).toBe(handoffComment(without));
    });

    it("defuses a checkbox at the head of any of its lines, so the Ticket's criteria stay as they were", () => {
      const body = "## Acceptance criteria\n\n- [ ] it reads the feed";
      const reason = "- [ ] it writes the feed\nTwo criteria collide:\n  * [ ] nested too";

      const comment = handoffComment({ ...noCommits, reason });

      expect(comment).toContain("- \\[ \\] it writes the feed");
      expect(comment).toContain("  * \\[ \\] nested too");
      expect(new RegExp(UNCHECKED_BOX, "m").test(comment)).toBe(false);
      // The merge ticks what it finds on the body and the comments together:
      // the hand-off adds no box for it to tick, nor one it reads as written.
      expect(tickCriteria([body, comment], ["it writes the feed", "nested too"])).toEqual([
        body,
        comment,
      ]);
    });
  });
});

describe("findMarkedComments", () => {
  it("gives every comment wearing the marker, oldest first", () => {
    const comments = [
      { id: "c1", body: `${HANDOFF_MARKER}\nfirst` },
      { id: "c2", body: "a human" },
      { id: "c3", body: `${HANDOFF_MARKER}\nsecond` },
    ];

    expect(findMarkedComments(comments, HANDOFF_MARKER).map(({ id }) => id)).toEqual([
      "c1",
      "c3",
    ]);
  });

  it("gives none when the marker is not the first line of any comment", () => {
    expect(findMarkedComments([{ body: `quoting ${HANDOFF_MARKER}` }], HANDOFF_MARKER)).toEqual(
      [],
    );
  });
});

describe("findMarkedComment", () => {
  it("gives the newest of several, not the oldest", () => {
    const comments = [
      { id: "c1", body: `${HANDOFF_MARKER}\nfirst` },
      { id: "c2", body: "a human" },
      { id: "c3", body: `${HANDOFF_MARKER}\nsecond` },
    ];

    expect(findMarkedComment(comments, HANDOFF_MARKER)?.id).toBe("c3");
  });

  it("gives nothing when no comment wears the marker", () => {
    expect(findMarkedComment([{ id: "c1", body: "a human" }], HANDOFF_MARKER)).toBeUndefined();
  });
});

describe("handoffTakenComment", () => {
  const handoff = handoffComment({
    stage: "verify",
    failure: "1 criterion unmet",
    branch: "agent/2-skeleton",
    evidence: "docs updated — nothing written",
  });

  it("puts the line under the marker, above the failure it qualifies", () => {
    expect(handoffTakenComment(handoff)?.split("\n").slice(0, 3)).toEqual([
      HANDOFF_MARKER,
      HANDOFF_TAKEN_LINE,
      "",
    ]);
  });

  it("changes nothing else about the comment", () => {
    const marked = handoffTakenComment(handoff) ?? "";

    expect(marked.replace(`${HANDOFF_TAKEN_LINE}\n\n`, "")).toBe(handoff);
  });

  it("gives nothing back for a comment that already carries the line", () => {
    expect(handoffTakenComment(handoffTakenComment(handoff) ?? "")).toBeUndefined();
  });

  it("marks a hand-off whose evidence only quotes the line", () => {
    const quoting = handoffComment({
      stage: "checks",
      failure: "`npm test` failed",
      branch: "agent/2-skeleton",
      evidence: `a doc under test reads ${HANDOFF_TAKEN_LINE}`,
    });

    expect(handoffTakenComment(quoting)?.split("\n")[1]).toBe(HANDOFF_TAKEN_LINE);
  });
});

describe("guardComment", () => {
  it("opens with the marker the pipeline finds its own warning by", () => {
    expect(guardComment("spec").split("\n")[0]).toBe("<!-- ticket-runner:guard:spec -->");
  });

  it("gives a marker per reason, so one warning does not silence another", () => {
    expect(guardMarker("no-criteria")).not.toBe(guardMarker("body-only-blockers"));
  });

  it("says a Spec was treated as one and that the label is gone", () => {
    const comment = guardComment("spec");

    expect(comment).toContain("**Skipped by ticket-runner.**");
    expect(comment).toContain("it is a Spec, not a Ticket");
    expect(comment).toContain("`ready-for-agent` was removed");
  });

  it("tells a criteria-less Ticket what verify needs", () => {
    expect(guardComment("no-criteria")).toContain(
      "No `- [ ]` acceptance criteria found in the body or comments.",
    );
  });

  it("tells a body-only blocker how to make the edge native", () => {
    expect(guardComment("body-only-blockers")).toContain("--add-blocked-by");
  });
});

describe("runSummary", () => {
  const merged = {
    outcome: "merged" as const,
    ticket: 3,
    title: "Run: drain the Frontier",
    branch: "agent/3-run-drain-the-frontier",
    pullRequest: 12,
    notes: [],
  };
  const handed = {
    outcome: "handed-off" as const,
    ticket: 5,
    title: "Fix Stage with a single retry",
    branch: "agent/5-fix-stage",
    stage: "verify" as const,
    failure: "1 unmet",
    notes: [],
  };
  const released = {
    outcome: "released" as const,
    ticket: 6,
    title: "Rebase conflict resolution",
    branch: "agent/6-rebase-conflict-resolution",
    stage: "implement" as const,
    cause: "rate-limited" as const,
    notes: [],
  };

  it("heads the summary with the version, the Run and how long it took", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 42 * 60_000,
      outcomes: [],
      stop: { reason: "frontier", blocked: [] },
    });

    expect(summary.split("\n")[0]).toBe(`ticket-runner ${VERSION} run r1 · 42m · subscription`);
  });

  /**
   * Above the header rather than below it: a Run that has been going all night
   * ends in a summary the human scrolls back to, and the line they most need
   * out of it is the one saying the pipeline they ran is not the current one.
   */
  it("puts the newer-version line at the head, above the header", () => {
    const newer = "A newer version is out: 0.5.0, and this is 0.4.0 — upgrade.";
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [],
      newer,
      stop: { reason: "frontier", blocked: [] },
    });

    const [first, second] = summary.split("\n");
    expect(first).toBe(newer);
    expect(second).toBe(`ticket-runner ${VERSION} run r1 · 0m · subscription`);
  });

  it("heads the summary with the Run where no newer version is out", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [],
      stop: { reason: "frontier", blocked: [] },
    });

    expect(summary.split("\n")[0]).toBe(`ticket-runner ${VERSION} run r1 · 0m · subscription`);
  });

  it("lists merged, handed-off and skipped Tickets by number", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [merged, handed],
      stop: { reason: "frontier", blocked: [9] },
    });

    expect(summary).toContain("  merged   #3 Run: drain the Frontier (PR #12)");
    expect(summary).toContain("  handed   #5 Fix Stage with a single retry · verify · 1 unmet");
    expect(summary).toContain("  skipped  #9 blocked");
  });

  it("gives an unexpected failure the command and how it exited, on one line", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [{ ...handed, stage: "rebase", failure: UNEXPECTED }],
      stop: { reason: "frontier", blocked: [] },
    });

    expect(summary).toContain(`  handed   #5 Fix Stage with a single retry · rebase · ${PULL_FAILED}\n`);
    expect(summary).not.toContain("Permission denied");
  });

  it.each(GH_BODIES)("gives a GitHub failure on $case its command and how it exited", (gh) => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [{ ...handed, stage: "pr", failure: failedPullRequest(gh.body) }],
      stop: { reason: "frontier", blocked: [] },
    });

    expect(summary).toContain(
      `  handed   #5 Fix Stage with a single retry · pr · ${ghFailed(gh.first)}\n`,
    );
    expect(summary).not.toContain("Bad Gateway");
    expect(summary).not.toContain("playwright");
  });

  it("says where the rate limit landed on a released Ticket", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [released],
      stop: { reason: "rate-limited" },
    });

    expect(summary).toContain("  released #6 Rebase conflict resolution · rate limit at implement");
  });

  it("says a transient API failure, not the rate limit, released a Ticket it stopped", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [{ ...released, stage: "verify", cause: "api-error" }],
      stop: { reason: "api-error" },
    });

    expect(summary).toContain("  released #6 Rebase conflict resolution · API failure at verify");
    expect(summary).not.toContain("rate limit");
    expect(summary.trimEnd().split("\n").at(-1)).toBe("API failure.");
  });

  it("says a failing base branch released a Ticket, and names it, the command and the commit last", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [
        {
          ...released,
          stage: "checks",
          cause: "failing-base",
          notes: [
            {
              origin: 6,
              stage: "pipeline",
              issue: 31,
              opened: false,
              summary: "The base branch `main` fails `npm test`.",
            },
          ],
        },
      ],
      stop: {
        reason: "failing-base",
        baseBranch: "main",
        commit: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
        command: "npm test",
      },
    });

    expect(summary.split("\n").slice(2, 4)).toEqual([
      "  released #6 Rebase conflict resolution · failing base branch at checks",
      "  noted    #31 comment · from #6 pipeline · The base branch `main` fails `npm test`.",
    ]);
    expect(summary).not.toContain("rate limit");
    expect(summary.trimEnd().split("\n").at(-1)).toBe(
      "Base branch `main` fails `npm test` at 1a2b3c4.",
    );
  });

  it("names the guard that passed a candidate over", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [
        { outcome: "skipped", ticket: 7, title: "Progress comment", reason: "no-criteria" },
      ],
      stop: { reason: "frontier", blocked: [9] },
    });

    expect(summary).toContain("  skipped  #7 no-criteria");
    expect(summary).toContain("  skipped  #9 blocked");
  });

  it("says the Frontier is empty when nothing was left blocked", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [merged],
      stop: { reason: "frontier", blocked: [] },
    });

    expect(summary.trimEnd().split("\n").at(-1)).toBe("Frontier empty.");
  });

  it("says the Frontier is blocked when candidates were held back", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [],
      stop: { reason: "frontier", blocked: [9] },
    });

    expect(summary.trimEnd().split("\n").at(-1)).toBe("Frontier blocked.");
  });

  it("says the rate limit stopped a Run a Release ended", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [released],
      stop: { reason: "rate-limited" },
    });

    expect(summary.trimEnd().split("\n").at(-1)).toBe("Rate limited.");
  });

  it("says when the limit resets, in UTC to the minute, where the CLI said", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [released],
      stop: { reason: "rate-limited", resetsAt: "2026-09-19T17:40:59.000Z" },
    });

    expect(summary.trimEnd().split("\n").at(-1)).toBe(
      "Rate limited · resets 2026-09-19 17:40 UTC.",
    );
  });

  it("reports nothing but the released Ticket when the rate limit stopped the Run", () => {
    // A Run stopped this way cannot say a candidate was held back all Run, so
    // the stop carries no candidates to skip and the summary skips none.
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [released],
      stop: { reason: "rate-limited" },
    });

    expect(summary).not.toContain("skipped");
  });

  it("says when a Stop arrived and what its Lanes were finishing", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [merged, released],
      stop: { reason: "stopped", at: "2026-09-20T22:07:13.000Z", busy: [3, 6] },
    });

    expect(summary.trimEnd().split("\n").at(-1)).toBe("Stopped at 22:07 · finishing #3 #6.");
  });

  it("says no Lane was busy when the Stop arrived to an idle Run", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [],
      stop: { reason: "stopped", at: "2026-09-20T22:07:13.000Z", busy: [] },
    });

    expect(summary.trimEnd().split("\n").at(-1)).toBe("Stopped at 22:07 · nothing to finish.");
  });

  it("reports nothing but its own Lanes when a Stop ended the Run", () => {
    // Like a Run the limit stopped, it ended before it could say a candidate
    // was held back all Run, so it says nothing about one.
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [merged],
      stop: { reason: "stopped", at: "2026-09-20T22:07:13.000Z", busy: [3] },
    });

    expect(summary).not.toContain("skipped");
  });

  it("says so when a Run found nothing to take", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [],
      stop: { reason: "frontier", blocked: [] },
    });

    expect(summary).toContain("  nothing to do");
  });

  it("says why each Ticket a narrowed Run was given and never took was skipped", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [
        merged,
        { outcome: "skipped", ticket: 57, reason: "pull-request" },
        { outcome: "skipped", ticket: 99, reason: "no-issue" },
      ],
      stop: { reason: "frontier", blocked: [13] },
    });

    expect(summary.split("\n").slice(2, 6)).toEqual([
      "  merged   #3 Run: drain the Frontier (PR #12)",
      "  skipped  #57 pull-request",
      "  skipped  #99 no-issue",
      "  skipped  #13 blocked",
    ]);
  });

  describe("of a Run on the API key", () => {
    /** A summary of a Run started with `--api-key`, with nothing in it but what is given. */
    function onTheKey(overrides: Partial<Parameters<typeof runSummary>[0]> = {}): string {
      return runSummary({
        credential: "api-key",
        version: VERSION,
        runId: "r1",
        durationMs: 0,
        outcomes: [],
        stop: { reason: "frontier", blocked: [] },
        ...overrides,
      });
    }

    it("names the API key in its header, and what the Run spent on it", () => {
      const header = (billing: Partial<Billing>) =>
        onTheKey({ billing: { ...emptyBilling(), ...billing } }).split("\n")[0];

      expect(onTheKey().split("\n")[0]).toBe(`ticket-runner ${VERSION} run r1 · 0m · API key · $0.00`);
      expect(header({ spendUsd: 12.3449 })).toBe(
        `ticket-runner ${VERSION} run r1 · 0m · API key · $12.34`,
      );
      expect(header({ spendUsd: 12.34, spendUnreported: true })).toMatch(/ · API key · \$12\.34\+$/);
      expect(header({ spendUnreported: true })).toMatch(/ · API key · \$0\.00\+$/);
    });

    it("never says extra usage, which only a subscription has", () => {
      expect(onTheKey({ billing: { ...emptyBilling(), extraUsage: true } }).split("\n")[0]).toMatch(
        / · API key · \$0\.00$/,
      );
    });

    it("says a Ticket was released out of API budget, and ends on it", () => {
      const summary = onTheKey({
        outcomes: [{ ...released, cause: "out-of-budget" }],
        stop: { reason: "out-of-budget" },
      });

      expect(summary).toContain(
        "  released #6 Rebase conflict resolution · out of API budget at implement",
      );
      expect(summary.trimEnd().split("\n").at(-1)).toBe("Out of API budget.");
    });

    it("puts its rate limit down to the API's", () => {
      const summary = onTheKey({
        outcomes: [released],
        stop: { reason: "rate-limited", resetsAt: "2026-09-20T03:40:00.000Z" },
      });

      expect(summary).toContain("  released #6 Rebase conflict resolution · API rate limit at implement");
      expect(summary.trimEnd().split("\n").at(-1)).toBe(
        "API rate limited · resets 2026-09-20 03:40 UTC.",
      );
      expect(onTheKey({ outcomes: [released], stop: { reason: "rate-limited" } })).toMatch(
        /\nAPI rate limited\.\n$/,
      );
    });
  });

  it("names each Stage that ran on another credential, after its own Ticket's rows", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [merged, handed],
      billing: {
        ...emptyBilling(),
        strays: [
          { ticket: 5, stage: "verify", apiKeySource: "apiKeyHelper" },
          { ticket: 3, stage: "implement", apiKeySource: "ANTHROPIC_API_KEY", costUsd: 4.15 },
        ],
      },
      stop: { reason: "frontier", blocked: [] },
    });

    expect(summary.split("\n")[0]).toBe(`ticket-runner ${VERSION} run r1 · 0m · subscription`);
    expect(summary.split("\n").slice(2, 6)).toEqual([
      "  merged   #3 Run: drain the Frontier (PR #12)",
      "  billed   #3 implement · apiKeySource ANTHROPIC_API_KEY · $4.15",
      "  handed   #5 Fix Stage with a single retry · verify · 1 unmet",
      "  billed   #5 verify · apiKeySource apiKeyHelper",
    ]);
  });

  it("gives a stray Stage's figure on its row of an `--api-key` Run, apart from the spend", () => {
    const summary = runSummary({
      credential: "api-key",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [merged],
      billing: {
        ...emptyBilling(),
        spendUsd: 1,
        strays: [{ ticket: 3, stage: "verify", apiKeySource: "apiKeyHelper", costUsd: 0.5 }],
      },
      stop: { reason: "frontier", blocked: [] },
    });

    expect(summary.split("\n")[0]).toMatch(/ · API key · \$1\.00$/);
    expect(summary).toContain("  billed   #3 verify · apiKeySource apiKeyHelper · $0.50");
  });

  it("ends a stray Stage's figure `+` where it is only part of the Stage's", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [merged],
      billing: {
        ...emptyBilling(),
        strays: [
          { ticket: 3, stage: "verify", apiKeySource: "apiKeyHelper", costUsd: 0.5, costIncomplete: true },
        ],
      },
      stop: { reason: "frontier", blocked: [] },
    });

    expect(summary).toContain("  billed   #3 verify · apiKeySource apiKeyHelper · $0.50+");
  });

  it("says a subscription Run used extra usage, with no amount", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [],
      billing: { ...emptyBilling(), extraUsage: true, spendUsd: 3, spendUnreported: true },
      stop: { reason: "frontier", blocked: [] },
    });

    expect(summary.split("\n")[0]).toBe(
      `ticket-runner ${VERSION} run r1 · 0m · subscription · extra usage`,
    );
  });
});

describe("noteComment", () => {
  const note = {
    summary: "`tool sync --help` prints a dump in place of its help text.",
    evidence:
      "argparse reads the literal `50%` as %-formatting.\nThe string is at src/cli/sync.py:40.",
    impact: "every reader of that help text.",
    next: "write it as `50%%`.",
  };
  const subject = { origin: 12, stage: "verify" as const, note };

  it("opens with the marker, then where the Note came from", () => {
    expect(noteComment(subject).split("\n").slice(0, 2)).toEqual([NOTE_MARKER, "From #12 verify"]);
  });

  it("carries the summary in bold, then each part under a label of its own, in order", () => {
    expect(noteComment(subject)).toBe(
      [
        NOTE_MARKER,
        "From #12 verify",
        "",
        "**`tool sync --help` prints a dump in place of its help text.**",
        "",
        "**Evidence**: argparse reads the literal `50%` as %-formatting.",
        "The string is at src/cli/sync.py:40.",
        "",
        "**Impact**: every reader of that help text.",
        "",
        "**Next**: write it as `50%%`.",
        "",
      ].join("\n"),
    );
  });

  it("leaves out a part the Stage did not write", () => {
    const comment = noteComment({
      ...subject,
      note: { summary: note.summary, impact: note.impact },
    });

    expect(comment).toBe(
      `${NOTE_MARKER}\nFrom #12 verify\n\n**${note.summary}**\n\n**Impact**: ${note.impact}\n`,
    );
  });

  it("leaves out a part the Stage left blank, label and all", () => {
    const comment = noteComment({ ...subject, note: { ...note, evidence: " \n", next: "" } });

    expect(comment).not.toContain("**Evidence**");
    expect(comment).not.toContain("**Next**");
    expect(comment).toContain("**Impact**");
  });

  it("keeps the summary on one line, so its bold holds", () => {
    const comment = noteComment({ ...subject, note: { summary: "  the flag\n\nis wrong \n" } });

    expect(comment).toContain("\n**the flag is wrong**\n");
  });

  it.each(["summary", "evidence", "impact", "next"] as const)(
    "defuses a checkbox in the %s so no guard reads it as Acceptance Criteria",
    (part) => {
      const comment = noteComment({
        ...subject,
        note: { ...note, [part]: "- [ ] rename the flag" },
      });

      expect(comment).toContain("- \\[ \\] rename the flag");
      expect(new RegExp(UNCHECKED_BOX, "m").test(comment)).toBe(false);
    },
  );
});

describe("a Note that fell back to the standing Notes issue", () => {
  const subject = {
    origin: 10,
    stage: "fix" as const,
    note: {
      summary: "Nothing cleans up abandoned worktrees.",
      impact: "A Run leaks one per hand-off.",
    },
  };

  it("names the Ticket it was meant for, and why that Ticket did not get it", () => {
    const comment = noteComment({ ...subject, intended: 7, because: "is claimed" });

    expect(comment.split("\n")[1]).toBe("From #10 fix, meant for #7, which is claimed");
  });

  it("says only that the Ticket refused it when there is no reason to give", () => {
    const comment = noteComment({ ...subject, intended: 404 });

    expect(comment.split("\n")[1]).toBe(
      "From #10 fix, meant for #404, which would not take the comment",
    );
  });

  it("carries the Note under the provenance, checkboxes defused", () => {
    const comment = noteComment({
      ...subject,
      intended: 7,
      note: { ...subject.note, evidence: "todo\n- [ ] one" },
    });

    expect(comment).toContain("- \\[ \\] one");
    expect(new RegExp(UNCHECKED_BOX, "m").test(comment)).toBe(false);
  });
});

describe("failingBaseNote", () => {
  const subject = {
    origin: 6,
    baseBranch: "main",
    branch: "agent/6-x",
    commit: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
    command: "npm test",
    output: "FAIL src/date.test.ts\n  expected 2026 to be 2025\n",
    timedOut: false,
    onBranch: {
      point: "checks" as const,
      command: "npm test",
      output: "FAIL src/clock.test.ts\n  2246 ms is not below 2000 ms\n",
      timedOut: false,
    },
  };
  /** The same Note for a Ticket whose pull request CI failed. */
  const atCi = (excerpt: string) => ({
    ...subject,
    onBranch: { point: "ci" as const, summary: "test failed, lint cancelled", excerpt },
  });

  it("is the pipeline's Note: the failing Check, where it fails, and the tail of what it printed there and on the branch", () => {
    expect(failingBaseNote(subject)).toBe(
      [
        NOTE_MARKER,
        "From the pipeline, releasing #6 at checks",
        "",
        "**The base branch `main` fails `npm test`.**",
        "",
        "**Evidence**: `npm test` failed in a clean worktree at 1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d, the merge-base of `agent/6-x` with `main`. The tail of its output:",
        "",
        "```",
        "FAIL src/date.test.ts",
        "  expected 2026 to be 2025",
        "```",
        "",
        "The branch's own failure, which need not be the same: `npm test` failed on `agent/6-x`. The tail of the branch's output:",
        "",
        "```",
        "FAIL src/clock.test.ts",
        "  2246 ms is not below 2000 ms",
        "```",
        "",
        "**Impact**: every Ticket whose branch inherits 1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d fails the same Check. #6 was released with its fix budget as it was, and the Run claimed no more Tickets.",
        "",
        "**Next**: mend `npm test` on `main`. The next Run takes the released Tickets up again from their state files, rebased onto `main` before their Checks.",
        "",
      ].join("\n"),
    );
  });

  it("summarises itself in the words its bold line carries", () => {
    expect(failingBaseSummary("main", "npm test")).toBe("The base branch `main` fails `npm test`.");
  });

  it("quotes only the last 40 lines, in a fence no backticks in them can close", () => {
    const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
    lines[45] = "```js";
    const note = failingBaseNote({ ...subject, output: lines.join("\n") });

    expect(note).not.toContain("line 10\n");
    expect(note).toContain("````\n… (10 earlier lines omitted)\nline 11\n");
    expect(note).toContain("line 50\n````");
  });

  /** What the Note quotes between its first fences, the merge-base's output. */
  const firstQuote = (note: string) => (/^```\n([\s\S]*?)\n```$/m.exec(note) as RegExpExecArray)[1] as string;

  it("quotes no more characters than the cap, saying what it left out, when the lines are long", () => {
    const error = `src/x.ts(1,1): error TS2322: Type '${"{ a: string; }".repeat(150)}' is not assignable.`;
    const output = Array.from({ length: 60 }, (_, index) => `${index + 1} ${error}`).join("\n");
    const note = failingBaseNote({ ...subject, output });

    const [omission, ...kept] = firstQuote(note).split("\n");
    expect(error.length).toBeGreaterThan(2_000);
    expect(omission).toBe("… (59 earlier lines omitted)");
    expect(kept.join("\n").length).toBeLessThanOrEqual(MAX_TAIL_CHARS);
    expect(kept.join("\n")).toMatch(/^60 src/);
    expect(note.length).toBeLessThan(65_536);
  });

  it("keeps the end of one line too long to quote whole, saying its start was cut", () => {
    const output = `${"x".repeat(5_000)}assertion failed`;
    const note = failingBaseNote({ ...subject, output });

    const [omission, ...kept] = firstQuote(note).split("\n");
    expect(omission).toBe("… (the start of this line omitted)");
    expect(kept.join("\n")).toBe(output.slice(-MAX_TAIL_CHARS));
  });

  it("says a Check the limit killed timed out, and one that printed nothing printed nothing", () => {
    const note = failingBaseNote({
      ...subject,
      output: " \n",
      timedOut: true,
      onBranch: { ...subject.onBranch, output: "", timedOut: true },
    });

    expect(note).toContain("`npm test` timed out in a clean worktree");
    expect(note).toContain("`main`. It printed nothing.");
    expect(note).toContain("`npm test` timed out on `agent/6-x`. It printed nothing.");
    expect(note).not.toContain("```");
  });

  it("defuses a checkbox in the output it quotes, the merge-base's and the branch's", () => {
    const note = failingBaseNote({
      ...subject,
      output: "- [ ] todo\n",
      onBranch: { ...subject.onBranch, output: "* [ ] also\n" },
    });

    expect(new RegExp(UNCHECKED_BOX, "m").test(note)).toBe(false);
  });

  it("quotes only the tail of the branch's output, in a fence of its own", () => {
    const lines = Array.from({ length: 50 }, (_, index) => `branch line ${index + 1}`);
    lines[49] = "``` and ````";
    const note = failingBaseNote({ ...subject, onBranch: { ...subject.onBranch, output: lines.join("\n") } });

    expect(note).toContain("```\nFAIL src/date.test.ts\n  expected 2026 to be 2025\n```\n");
    expect(note).not.toContain("branch line 10\n");
    expect(note).toContain("`````\n… (10 earlier lines omitted)\nbranch line 11\n");
    expect(note).toContain("``` and ````\n`````\n");
  });

  it("says CI was what failed when CI was", () => {
    expect(failingBaseNote(atCi("test\nFAIL")).split("\n")[1]).toBe("From the pipeline, releasing #6 at ci");
  });

  it("quotes the failing jobs' logs for CI as a fix Stage would be handed them", () => {
    const excerpt = [
      "test",
      ...Array.from({ length: 40 }, (_, index) => `test line ${index + 1}`),
      "",
      "lint",
      "(the log was unavailable; the job is at https://github.com/o/r/actions/runs/1/job/2)",
    ].join("\n");
    const note = failingBaseNote(atCi(excerpt));

    expect(note).toContain(
      "The branch's own failure, which need not be the same: CI on the pull request from `agent/6-x` reported test failed, lint cancelled. The tail of the failing jobs' logs:",
    );
    expect(note).toContain(`\n\`\`\`\n${excerpt}\n\`\`\`\n`);
  });

  it("says CI had no log to quote when no failing check was an Actions job", () => {
    const note = failingBaseNote(atCi(""));

    expect(note).toContain(
      "CI on the pull request from `agent/6-x` reported test failed, lint cancelled. No failing job had a log to quote.",
    );
  });
});

describe("notesIssue", () => {
  it("opens under the one fixed title", () => {
    expect(notesIssue().title).toBe(NOTES_ISSUE_TITLE);
  });

  it("carries the marker it is found again by, on the first line of the body", () => {
    expect(notesIssue().body.split("\n")[0]).toBe(NOTES_ISSUE_MARKER);
  });

  it("is not signed with the Note comments' own marker", () => {
    expect(notesIssue().body).not.toContain(NOTE_MARKER);
  });

  it("tells triage what the issue is and how it is emptied", () => {
    const body = notesIssue().body;

    expect(body).toContain("arrives here as a comment");
    expect(body).toContain("close the issue");
  });

  it("recognises its own body again, and nothing else", () => {
    expect(isNotesIssue(notesIssue().body)).toBe(true);
    expect(isNotesIssue("Notes from the pipeline\n\nsomething a human wrote")).toBe(false);
    expect(isNotesIssue(`${NOTE_MARKER}\nFrom #10 fix\n`)).toBe(false);
  });
});

describe("Notes in a Run summary", () => {
  const merged = {
    outcome: "merged" as const,
    ticket: 3,
    title: "Run: drain the Frontier",
    branch: "agent/3-run-drain-the-frontier",
    pullRequest: 12,
    notes: [],
  };
  const handed = {
    outcome: "handed-off" as const,
    ticket: 5,
    title: "Fix Stage with a single retry",
    branch: "agent/5-fix-stage",
    stage: "verify" as const,
    failure: "1 unmet",
    notes: [],
  };
  const note = {
    origin: 3,
    stage: "implement" as const,
    issue: 8,
    opened: false,
    summary: "the CLI help drifts from the README",
  };

  it("follows the row of the Ticket whose Stage made it", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [{ ...merged, notes: [note] }, handed],
      stop: FRONTIER_EMPTY,
    });

    expect(summary.split("\n").slice(2, 5)).toEqual([
      "  merged   #3 Run: drain the Frontier (PR #12)",
      "  noted    #8 comment · from #3 implement · the CLI help drifts from the README",
      "  handed   #5 Fix Stage with a single retry · verify · 1 unmet",
    ]);
  });

  it("reports a Note the verify Stage made the way it reports the others", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [{ ...merged, notes: [{ ...note, stage: "verify" as const }] }],
      stop: FRONTIER_EMPTY,
    });

    expect(summary).toContain(
      "  noted    #8 comment · from #3 verify · the CLI help drifts from the README",
    );
  });

  it("says when the Note opened an issue of its own", () => {
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [
        { ...merged, notes: [{ ...note, issue: 31, opened: true, summary: "no cleanup" }] },
      ],
      stop: FRONTIER_EMPTY,
    });

    expect(summary).toContain("  noted    #31 new · from #3 implement · no cleanup");
  });

  it("trims a long Note to one line", () => {
    const long = `worktrees ${"pile ".repeat(40)}up`;
    const summary = runSummary({
      credential: "subscription",
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [{ ...merged, notes: [{ ...note, summary: long }] }],
      stop: FRONTIER_EMPTY,
    });

    const row = summary.split("\n").find((line) => line.includes("noted")) as string;
    expect(row).not.toContain(long);
    expect(row.length).toBeLessThan(90);
    expect(row.endsWith("\u2026")).toBe(true);
  });

  it("says nothing extra for a Ticket whose Stages found nothing", () => {
    const summary = runSummary({ credential: "subscription", version: VERSION, runId: "r1", durationMs: 0, outcomes: [merged], stop: FRONTIER_EMPTY });

    expect(summary).not.toContain("noted");
  });
});
