import { describe, expect, it } from "vitest";
import { FakeTracker } from "./testing/fakes.js";
import { resolveTranscriptHome } from "./transcript-home.js";

function trackerSaying(visibility: "public" | "private" | undefined): FakeTracker {
  const tracker = new FakeTracker();
  tracker.targetVisibility = visibility;
  return tracker;
}

describe("where a Run keeps a handed-off Ticket's transcripts", () => {
  it("keeps them on a private Target's remote when the config says nothing", async () => {
    const tracker = trackerSaying("private");

    expect(await resolveTranscriptHome({ config: {}, tracker, host: "workstation" })).toEqual({
      home: "remote",
    });
    expect(tracker.visibilityLookups).toBe(1);
  });

  it.each(["workstation", "cloud"] as const)(
    "keeps them off a public Target's remote, on the %s, when the config says nothing",
    async (host) => {
      expect(
        await resolveTranscriptHome({ config: {}, tracker: trackerSaying("public"), host }),
      ).toEqual({ home: host });
    },
  );

  it("counts a Target whose visibility cannot be read as public, and says so in one line", async () => {
    const resolved = await resolveTranscriptHome({
      config: {},
      tracker: trackerSaying(undefined),
      host: "workstation",
    });

    expect(resolved.home).toBe("workstation");
    expect(resolved.said).toMatch(/counts as public/);
    expect(resolved.said).not.toContain("\n");
  });

  it("keeps them on a public Target's remote when the config says true, asking nothing", async () => {
    const tracker = trackerSaying("public");

    expect(
      await resolveTranscriptHome({ config: { keepTranscripts: true }, tracker, host: "cloud" }),
    ).toEqual({ home: "remote" });
    expect(tracker.visibilityLookups).toBe(0);
  });

  it("keeps them off a private Target's remote when the config says false", async () => {
    const tracker = trackerSaying("private");

    expect(
      await resolveTranscriptHome({
        config: { keepTranscripts: false },
        tracker,
        host: "workstation",
      }),
    ).toEqual({ home: "workstation" });
    expect(tracker.visibilityLookups).toBe(0);
  });
});
