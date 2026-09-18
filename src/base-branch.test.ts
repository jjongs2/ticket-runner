import { describe, expect, it } from "vitest";
import { resolveBaseBranch } from "./base-branch.js";
import { FakeTracker } from "./testing/fakes.js";

describe("resolveBaseBranch", () => {
  it("takes the Target's default branch when the config names none", async () => {
    const tracker = new FakeTracker();
    tracker.defaultBranchName = "master";

    expect(await resolveBaseBranch(tracker, {})).toBe("master");
  });

  it("lets the config file's baseBranch win over what GitHub answers", async () => {
    const tracker = new FakeTracker();
    tracker.defaultBranchName = "master";

    expect(await resolveBaseBranch(tracker, { baseBranch: "release" })).toBe("release");
  });

  it("does not ask GitHub at all when the config names one", async () => {
    const tracker = new FakeTracker();
    tracker.defaultBranch = () => Promise.reject(new Error("gh was asked"));

    await expect(resolveBaseBranch(tracker, { baseBranch: "release" })).resolves.toBe("release");
  });
});
