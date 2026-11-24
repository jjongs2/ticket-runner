import { describe, expect, it } from "vitest";
import { claimBranch, namedBranch, parseBranchSlug, worktreePath } from "./branch.js";

describe("claimBranch", () => {
  it("is agent/<n>, with nothing cut from the Ticket title", () => {
    expect(claimBranch(2)).toBe("agent/2");
  });
});

describe("namedBranch", () => {
  it("puts the slug after the Ticket number", () => {
    expect(namedBranch(7, "notification-settings-screen")).toBe(
      "agent/7-notification-settings-screen",
    );
  });
});

describe("parseBranchSlug", () => {
  it("takes a slug in shape, trimmed", () => {
    expect(parseBranchSlug({ branch: " name-the-branch-at-implement " })).toEqual({
      kind: "slug",
      slug: "name-the-branch-at-implement",
    });
  });

  it("takes a slug of exactly 40 characters", () => {
    const slug = `${"a".repeat(19)}-${"b".repeat(20)}`;
    expect(slug).toHaveLength(40);
    expect(parseBranchSlug({ branch: slug })).toEqual({ kind: "slug", slug });
  });

  it.each([
    ["longer than 40 characters", `${"a".repeat(20)}-${"b".repeat(20)}`],
    ["uppercase", "Name-the-branch"],
    ["a doubled dash", "name--branch"],
    ["a leading dash", "-name"],
    ["a trailing dash", "name-"],
    ["Hangul", "알림-설정"],
    ["a slash", "feat/name"],
    ["an underscore", "name_branch"],
  ])("calls a slug with %s out of shape", (_why, answered) => {
    expect(parseBranchSlug({ branch: answered })).toEqual({ kind: "out-of-shape", answered });
  });

  it.each([
    ["no output", undefined],
    ["output that is not an object", "agent/4-x"],
    ["no branch field", { title: "feat: x" }],
    ["a blank branch", { branch: "  " }],
    ["a branch that is not a string", { branch: 4 }],
  ])("finds no slug in %s", (_why, result) => {
    expect(parseBranchSlug(result)).toEqual({ kind: "empty" });
  });
});

describe("worktreePath", () => {
  it("puts each Ticket under the gitignored worktree directory", () => {
    expect(worktreePath("/repo", 2)).toBe("/repo/.worktrees/ticket-2");
  });
});
