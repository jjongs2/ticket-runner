import { describe, expect, it } from "vitest";
import {
  HANDOFF_MARKER,
  guardComment,
  guardMarker,
  handoffComment,
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

describe("pullRequestBody", () => {
  it("starts with Closes #<n> on its own line so the merge closes the Ticket", () => {
    const body = pullRequestBody({ ticket: 2, verdict, runId: "r1" });

    expect(body.split("\n")[0]).toBe("Closes #2");
  });

  it("summarises the Verdict by status count", () => {
    const body = pullRequestBody({ ticket: 2, verdict, runId: "r1" });

    expect(body).toContain("**Verdict:** 1 met · 0 unmet · 1 unverifiable");
  });

  it("lists every criterion, with evidence for the ones not met", () => {
    const body = pullRequestBody({ ticket: 2, verdict, runId: "r1" });

    expect(body).toContain("- ✅ tests pass");
    expect(body).toContain("- ❓ docs updated — no way to tell");
  });

  it("points at the transcripts for the Run", () => {
    const body = pullRequestBody({ ticket: 2, verdict, runId: "r1" });

    expect(body).toContain("Run `r1` · transcripts in `.agent-pipeline/runs/r1/2/`");
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

  it("uses the pull request title as the subject and appends the PR number as GitHub would", () => {
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

  it("opens the body with Closes, then the Verdict counts, then the branch commits in order", () => {
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

  it("names the draft PR when one was opened", () => {
    expect(handoffComment({ ...base, pullRequest: 12 })).toContain("PR #12 (draft)");
  });

  it("omits the PR clause when no PR exists", () => {
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

  it("says so when the Ticket had already spent its fix budget", () => {
    expect(handoffComment({ ...base, fixUsed: true })).toContain(
      "Failed at **verify**, after the fix budget was used.",
    );
  });

  it("says nothing about the budget when no fix Stage ran", () => {
    expect(handoffComment(base)).toContain("Failed at **verify**.");
    expect(handoffComment(base)).not.toMatch(/fix budget/i);
  });
});

describe("guardComment", () => {
  it("opens with the marker the pipeline finds its own warning by", () => {
    expect(guardComment("spec").split("\n")[0]).toBe("<!-- agent-pipeline:guard:spec -->");
  });

  it("gives a marker per reason, so one warning does not silence another", () => {
    expect(guardMarker("no-criteria")).not.toBe(guardMarker("body-only-blockers"));
  });

  it("says a Spec was treated as one and that the label is gone", () => {
    const comment = guardComment("spec");

    expect(comment).toContain("**Skipped by agent-pipeline.**");
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
  };
  const handed = {
    outcome: "handed-off" as const,
    ticket: 5,
    title: "Fix Stage with a single retry",
    branch: "agent/5-fix-stage",
    stage: "verify" as const,
    failure: "1 unmet",
  };

  it("heads the summary with the Run and how long it took", () => {
    const summary = runSummary({ runId: "r1", durationMs: 42 * 60_000, outcomes: [], blocked: [] });

    expect(summary.split("\n")[0]).toBe("agent-pipeline run r1 · 42m");
  });

  it("lists merged, handed-off and skipped Tickets by number", () => {
    const summary = runSummary({
      runId: "r1",
      durationMs: 0,
      outcomes: [merged, handed],
      blocked: [9],
    });

    expect(summary).toContain("  merged   #3 Run: drain the Frontier (PR #12)");
    expect(summary).toContain("  handed   #5 Fix Stage with a single retry · verify · 1 unmet");
    expect(summary).toContain("  skipped  #9 blocked");
  });

  it("names the guard that passed a candidate over", () => {
    const summary = runSummary({
      runId: "r1",
      durationMs: 0,
      outcomes: [
        { outcome: "skipped", ticket: 7, title: "Progress comment", reason: "no-criteria" },
      ],
      blocked: [9],
    });

    expect(summary).toContain("  skipped  #7 no-criteria");
    expect(summary).toContain("  skipped  #9 blocked");
  });

  it("says the Frontier is empty when nothing was left blocked", () => {
    const summary = runSummary({ runId: "r1", durationMs: 0, outcomes: [merged], blocked: [] });

    expect(summary.trimEnd().split("\n").at(-1)).toBe("Frontier empty.");
  });

  it("says the Frontier is blocked when candidates were held back", () => {
    const summary = runSummary({ runId: "r1", durationMs: 0, outcomes: [], blocked: [9] });

    expect(summary.trimEnd().split("\n").at(-1)).toBe("Frontier blocked.");
  });

  it("says so when a Run found nothing to take", () => {
    const summary = runSummary({ runId: "r1", durationMs: 0, outcomes: [], blocked: [] });

    expect(summary).toContain("  nothing to do");
  });

  it("claims nothing about the Frontier when one Ticket was named", () => {
    const summary = runSummary({ runId: "r1", durationMs: 0, outcomes: [merged] });

    expect(summary.trimEnd().split("\n").at(-1)).toBe(
      "  merged   #3 Run: drain the Frontier (PR #12)",
    );
  });
});
