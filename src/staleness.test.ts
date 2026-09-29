import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONVENTIONS_PATH, conventionsDoc } from "./conventions.js";
import { conventionsWarning, newerVersionLine } from "./staleness.js";
import { FakeTracker } from "./testing/fakes.js";

/** The pipeline's own repository, as its package names it. */
const REPOSITORY = "jjongs2/ticket-runner";

let repoRoot: string;
let tracker: FakeTracker;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "ticket-runner-staleness-"));
  tracker = new FakeTracker();
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function writeDocument(contents: string): void {
  const path = join(repoRoot, CONVENTIONS_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

describe("a newer Version being out", () => {
  it("names both Versions and how to upgrade", async () => {
    tracker.publishedVersionTag = "v0.5.0";

    const line = await newerVersionLine({ tracker, version: "0.4.0", repository: REPOSITORY });

    expect(line).toContain("0.5.0");
    expect(line).toContain("0.4.0");
    expect(line).toContain("upgrade with `npm install -g ticket-runner`");
    expect(line).not.toContain(REPOSITORY);
    expect(line?.split("\n")).toHaveLength(1);
  });

  it("asks about the repository it was given, and only once", async () => {
    tracker.publishedVersionTag = "v0.5.0";

    await newerVersionLine({ tracker, version: "0.4.0", repository: REPOSITORY });

    expect(tracker.versionTagLookups).toEqual([REPOSITORY]);
  });

  it("says nothing to a copy that is the latest", async () => {
    tracker.publishedVersionTag = "v0.4.0";

    expect(
      await newerVersionLine({ tracker, version: "0.4.0", repository: REPOSITORY }),
    ).toBeUndefined();
  });

  it("says nothing to a copy above the latest", async () => {
    tracker.publishedVersionTag = "v0.4.0";

    expect(
      await newerVersionLine({ tracker, version: "0.5.0", repository: REPOSITORY }),
    ).toBeUndefined();
  });

  /**
   * A development checkout runs a commit past the Version it reports, which is
   * the ordinary state of this repository's own checkout. Comparing anything
   * but the number would call it stale the moment its Version was published.
   */
  it("says nothing to a development checkout of the latest Version", async () => {
    tracker.publishedVersionTag = "v0.4.0";

    expect(
      await newerVersionLine({
        tracker,
        version: "0.4.0+abc1234",
        repository: REPOSITORY,
      }),
    ).toBeUndefined();
  });

  it("compares parts as numbers, so 0.10.0 is newer than 0.9.0", async () => {
    tracker.publishedVersionTag = "v0.10.0";

    const line = await newerVersionLine({ tracker, version: "0.9.0", repository: REPOSITORY });

    expect(line).toContain("0.10.0");
  });

  it("says nothing where the repository published no Release at all", async () => {
    expect(
      await newerVersionLine({ tracker, version: "0.4.0", repository: REPOSITORY }),
    ).toBeUndefined();
  });

  it("says nothing, and refuses nothing, where the lookup fails", async () => {
    tracker.versionTagFails = true;

    expect(
      await newerVersionLine({ tracker, version: "0.4.0", repository: REPOSITORY }),
    ).toBeUndefined();
  });

  it("asks nothing at all where the package names no repository", async () => {
    tracker.publishedVersionTag = "v0.5.0";

    const line = await newerVersionLine({ tracker, version: "0.4.0" });

    expect(line).toBeUndefined();
    expect(tracker.versionTagLookups).toEqual([]);
  });

  it("asks nothing at all where this copy has no number to compare", async () => {
    tracker.publishedVersionTag = "v0.5.0";

    const line = await newerVersionLine({ tracker, version: "unknown", repository: REPOSITORY });

    expect(line).toBeUndefined();
    expect(tracker.versionTagLookups).toEqual([]);
  });
});

describe("the Version a Target's conventions document was written by", () => {
  it("says nothing about a document this Version wrote", () => {
    writeDocument(conventionsDoc("0.4.0"));

    expect(conventionsWarning(repoRoot, "0.4.0+331d79c")).toBeUndefined();
  });

  it("names `init` for a document an older pipeline left", () => {
    writeDocument(conventionsDoc("0.3.0"));

    const warning = conventionsWarning(repoRoot, "0.4.0");

    expect(warning).toContain("0.3.0");
    expect(warning).toContain("0.4.0");
    expect(warning).toContain("ticket-runner init");
  });

  it("leaves a document carrying no mark at all to readiness, which refuses it", () => {
    writeDocument("# ticket-runner conventions\n\nFrom an older pipeline.\n");

    expect(conventionsWarning(repoRoot, "0.4.0")).toBeUndefined();
  });

  it("names the upgrade for a document a newer pipeline left", () => {
    writeDocument(conventionsDoc("0.5.0"));

    const warning = conventionsWarning(repoRoot, "0.4.0");

    expect(warning).toContain("0.5.0");
    expect(warning).toContain("upgrade");
    expect(warning).not.toContain("ticket-runner init");
  });

  it("says nothing where this copy has no number to compare", () => {
    writeDocument(conventionsDoc("0.3.0"));

    expect(conventionsWarning(repoRoot, "unknown")).toBeUndefined();
  });
});
