import { describe, expect, it } from "vitest";
import { HANDOFF_MARKER, handoffComment, pullRequestBody } from "./templates.js";
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
