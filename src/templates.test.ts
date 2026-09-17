import { describe, expect, it } from "vitest";
import {
  HANDOFF_MARKER,
  handoffComment,
  pullRequestBody,
  runSummary,
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
