import { describe, expect, it } from "vitest";
import {
  VERDICT_JSON_SCHEMA,
  countStatuses,
  parseVerdict,
  passes,
  unmetCriteria,
} from "./verdict.js";

const criterion = (status: string, text = "a criterion") => ({
  text,
  status,
  evidence: "looked at it",
});

describe("parseVerdict", () => {
  it("accepts the Verdict shape the schema asks for", () => {
    const verdict = parseVerdict({
      criteria: [criterion("met"), criterion("unverifiable")],
      pass: true,
    });

    expect(verdict.criteria).toHaveLength(2);
  });

  it("rejects an unknown status", () => {
    expect(() => parseVerdict({ criteria: [criterion("maybe")], pass: true })).toThrow();
  });

  it("rejects a Verdict with no criteria at all", () => {
    expect(() => parseVerdict({ criteria: [], pass: true })).toThrow();
  });

  it("rejects a missing result", () => {
    expect(() => parseVerdict(undefined)).toThrow();
  });
});

describe("passes", () => {
  it("passes when nothing is unmet and something is met", () => {
    const verdict = parseVerdict({
      criteria: [criterion("met"), criterion("unverifiable")],
      pass: false,
    });

    expect(passes(verdict)).toBe(true);
  });

  it("ignores the agent's own pass flag when it disagrees", () => {
    const verdict = parseVerdict({
      criteria: [criterion("met"), criterion("unmet")],
      pass: true,
    });

    expect(passes(verdict)).toBe(false);
  });

  it("fails a Verdict where every criterion is unverifiable", () => {
    const verdict = parseVerdict({
      criteria: [criterion("unverifiable"), criterion("unverifiable")],
      pass: true,
    });

    expect(passes(verdict)).toBe(false);
  });
});

describe("countStatuses", () => {
  it("counts each status", () => {
    const verdict = parseVerdict({
      criteria: [criterion("met"), criterion("met"), criterion("unmet")],
      pass: false,
    });

    expect(countStatuses(verdict)).toEqual({ met: 2, unmet: 1, unverifiable: 0 });
  });
});

describe("unmetCriteria", () => {
  it("returns only the criteria a fix Stage would have to address", () => {
    const verdict = parseVerdict({
      criteria: [criterion("met", "fine"), criterion("unmet", "broken")],
      pass: false,
    });

    expect(unmetCriteria(verdict).map((c) => c.text)).toEqual(["broken"]);
  });
});

describe("VERDICT_JSON_SCHEMA", () => {
  it("describes the criteria array the verify Stage must emit", () => {
    expect(VERDICT_JSON_SCHEMA).toMatchObject({
      type: "object",
      required: ["criteria", "pass"],
    });
  });
});
