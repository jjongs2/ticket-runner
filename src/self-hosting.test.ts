import { beforeEach, describe, expect, it } from "vitest";
import { isPipelineRepository, targetRepository } from "./self-hosting.js";
import { FakeTracker } from "./testing/fakes.js";

let tracker: FakeTracker;

beforeEach(() => {
  tracker = new FakeTracker();
});

describe("targetRepository", () => {
  it("is the Target's repository as GitHub names it", async () => {
    tracker.repositoryName = "acme/shop";

    expect(await targetRepository(tracker)).toBe("acme/shop");
  });

  it("is nothing where the Target's repository could not be read", async () => {
    tracker.repositoryName = undefined;

    expect(await targetRepository(tracker)).toBeUndefined();
  });

  it("is nothing where the tracker could not be asked at all", async () => {
    tracker.repositoryFails = true;

    expect(await targetRepository(tracker)).toBeUndefined();
  });
});

describe("isPipelineRepository", () => {
  it("is true where the Target's repository is the pipeline's own", () => {
    expect(isPipelineRepository("acme/ticket-runner", "acme/ticket-runner")).toBe(true);
  });

  it("reads the two names as GitHub does, whatever their case", () => {
    expect(isPipelineRepository("Acme/Ticket-Runner", "acme/ticket-runner")).toBe(true);
  });

  it("is false for any other Target", () => {
    expect(isPipelineRepository("acme/shop", "acme/ticket-runner")).toBe(false);
  });

  it("is false for a fork of the pipeline that is not the repository its package names", () => {
    expect(isPipelineRepository("someone/ticket-runner", "acme/ticket-runner")).toBe(false);
  });

  it("is false where the Target's repository could not be read", () => {
    expect(isPipelineRepository(undefined, "acme/ticket-runner")).toBe(false);
  });

  it("is false where the pipeline names no repository", () => {
    expect(isPipelineRepository("acme/ticket-runner", undefined)).toBe(false);
  });
});
