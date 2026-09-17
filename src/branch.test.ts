import { describe, expect, it } from "vitest";
import { branchName, worktreePath } from "./branch.js";

describe("branchName", () => {
  it("prefixes the Ticket number with agent/", () => {
    expect(branchName(2, "Skeleton: one Ticket end to end")).toBe(
      "agent/2-skeleton-one-ticket-end-to-end",
    );
  });

  it("lowercases and kebab-cases punctuation away", () => {
    expect(branchName(7, "Fix Stage, with a single retry!")).toBe(
      "agent/7-fix-stage-with-a-single-retry",
    );
  });

  it("caps the slug at 40 characters without a trailing dash", () => {
    const slug = branchName(
      11,
      "Resume a released Ticket from the recorded Stage later on",
    ).replace("agent/11-", "");
    expect(slug).toBe("resume-a-released-ticket-from-the");
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it("falls back to a placeholder when the title has no usable characters", () => {
    expect(branchName(4, "!!!")).toBe("agent/4-ticket");
  });
});

describe("worktreePath", () => {
  it("puts each Ticket under the gitignored worktree directory", () => {
    expect(worktreePath("/repo", 2)).toBe("/repo/.worktrees/ticket-2");
  });
});
