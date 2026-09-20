import { describe, expect, it } from "vitest";
import { highestTag, isHigher, tagNumber, versionNumber } from "./version-number.js";

describe("the number a Version string carries", () => {
  it("reads an installed copy's number as the whole of it", () => {
    expect(versionNumber("0.4.0")).toBe("0.4.0");
  });

  it("drops the commit a development checkout adds, dirty or not", () => {
    expect(versionNumber("0.4.0+331d79c")).toBe("0.4.0");
    expect(versionNumber("0.4.0+331d79c.dirty")).toBe("0.4.0");
  });

  it("has no number for a copy that could not read its own package", () => {
    expect(versionNumber("unknown")).toBeUndefined();
    expect(versionNumber("")).toBeUndefined();
    expect(versionNumber("0.4")).toBeUndefined();
  });
});

describe("the number a tag names", () => {
  it("reads a Version tag", () => {
    expect(tagNumber("v0.4.0")).toBe("0.4.0");
  });

  it("reads nothing from a tag that is not a Version", () => {
    expect(tagNumber("0.4.0")).toBeUndefined();
    expect(tagNumber("v1.0")).toBeUndefined();
    expect(tagNumber("nightly")).toBeUndefined();
  });
});

describe("the highest tag", () => {
  it("answers with the tag itself, so a message can name it as it was cut", () => {
    expect(highestTag(["v0.1.0", "v0.4.0", "v0.2.0"])).toBe("v0.4.0");
  });

  it("compares parts as numbers rather than as text", () => {
    expect(highestTag(["v0.9.0", "v0.10.0"])).toBe("v0.10.0");
  });

  it("ignores every tag that is not a Version", () => {
    expect(highestTag(["nightly", "v0.2.0", "release-3"])).toBe("v0.2.0");
  });

  it("has no answer for a repository with no Version tag at all", () => {
    expect(highestTag([])).toBeUndefined();
    expect(highestTag(["nightly"])).toBeUndefined();
  });
});

describe("which of two numbers is higher", () => {
  it("reads each part as a number", () => {
    expect(isHigher("0.10.0", "0.9.0")).toBe(true);
    expect(isHigher("0.9.0", "0.10.0")).toBe(false);
  });

  it("calls an equal number no higher", () => {
    expect(isHigher("0.4.0", "0.4.0")).toBe(false);
  });

  it("reads a missing part as zero", () => {
    expect(isHigher("1.0.1", "1")).toBe(true);
    expect(isHigher("1.0.0", "1")).toBe(false);
  });
});
