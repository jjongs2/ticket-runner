import { beforeEach, describe, expect, it } from "vitest";
import { isPipelineRepository } from "./self-hosting.js";
import { FakeTracker } from "./testing/fakes.js";

let tracker: FakeTracker;

beforeEach(() => {
  tracker = new FakeTracker();
});

describe("isPipelineRepository", () => {
  it("is true where the Target's repository is the pipeline's own", async () => {
    tracker.repositoryName = "acme/ticket-runner";

    expect(await isPipelineRepository(tracker, "acme/ticket-runner")).toBe(true);
  });

  it("reads the two names as GitHub does, whatever their case", async () => {
    tracker.repositoryName = "Acme/Ticket-Runner";

    expect(await isPipelineRepository(tracker, "acme/ticket-runner")).toBe(true);
  });

  it("is false for any other Target", async () => {
    tracker.repositoryName = "acme/shop";

    expect(await isPipelineRepository(tracker, "acme/ticket-runner")).toBe(false);
  });

  it("is false for a fork of the pipeline that is not the repository its package names", async () => {
    tracker.repositoryName = "someone/ticket-runner";

    expect(await isPipelineRepository(tracker, "acme/ticket-runner")).toBe(false);
  });

  it("is false where the Target's repository could not be read", async () => {
    tracker.repositoryName = undefined;

    expect(await isPipelineRepository(tracker, "acme/ticket-runner")).toBe(false);
  });

  it("is false where the tracker could not be asked at all", async () => {
    tracker.repositoryName = "acme/ticket-runner";
    tracker.repositoryFails = true;

    expect(await isPipelineRepository(tracker, "acme/ticket-runner")).toBe(false);
  });

  it("is false where the pipeline names no repository, and asks the tracker nothing", async () => {
    tracker.repositoryName = "acme/ticket-runner";
    tracker.repositoryFails = true;

    expect(await isPipelineRepository(tracker, undefined)).toBe(false);
    expect(tracker.repositoryLookups).toBe(0);
  });
});
