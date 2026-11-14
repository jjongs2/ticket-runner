import { describe, expect, it } from "vitest";
import { listCriteria } from "./acceptance-criteria.js";
import {
  VERDICT_JSON_SCHEMA,
  type Verdict,
  countStatuses,
  gradeVerdict,
  isMisnumbered,
  parseVerdict,
  passes,
  unmetCriteria,
} from "./verdict.js";

const answer = (number: number, status: string) => ({
  number,
  status,
  evidence: "looked at it",
});

/** Criteria 1 to 3, as the pipeline lists them off a Ticket. */
const LISTED = listCriteria(["- [ ] fine\n- [ ] broken\n- [ ] untested"]);

/** The verdict graded against {@link LISTED}, giving each criterion the status at its place. */
function graded(statuses: string[], defects: { summary: string; evidence: string }[] = []): Verdict {
  const result = gradeVerdict(
    parseVerdict({
      criteria: statuses.map((status, index) => answer(index + 1, status)),
      defects,
      pass: true,
    }),
    LISTED.slice(0, statuses.length),
  );
  if (isMisnumbered(result)) throw new Error("misnumbered");
  return result;
}

describe("parseVerdict", () => {
  it("accepts the verdict shape the schema asks for", () => {
    const verdict = parseVerdict({
      criteria: [answer(1, "met"), answer(2, "unverifiable")],
      pass: true,
    });

    expect(verdict.criteria).toHaveLength(2);
  });

  it("rejects an unknown status", () => {
    expect(() => parseVerdict({ criteria: [answer(1, "maybe")], pass: true })).toThrow();
  });

  it("rejects a criterion answered by its text rather than its number", () => {
    expect(() =>
      parseVerdict({ criteria: [{ text: "fine", status: "met", evidence: "ok" }], pass: true }),
    ).toThrow();
  });

  it("rejects a verdict with no criteria at all", () => {
    expect(() => parseVerdict({ criteria: [], pass: true })).toThrow();
  });

  it("rejects a missing result", () => {
    expect(() => parseVerdict(undefined)).toThrow();
  });

  it("accepts a verdict that carries Notes, and keeps nothing of them", () => {
    const verdict = parseVerdict({
      criteria: [answer(1, "met")],
      pass: true,
      notes: [{ summary: "the help text drifts" }],
    });

    expect(Object.keys(verdict).sort()).toEqual(["criteria", "defects", "pass"]);
  });

  it("reads a verdict that leaves the defects out as one that found none", () => {
    expect(parseVerdict({ criteria: [answer(1, "met")], pass: true }).defects).toEqual([]);
  });
});

describe("gradeVerdict", () => {
  it("joins each answer to the criterion its number names, in the list's order", () => {
    const result = gradeVerdict(
      parseVerdict({
        criteria: [answer(3, "unverifiable"), answer(1, "met"), answer(2, "unmet")],
        pass: false,
      }),
      LISTED,
    );

    expect(isMisnumbered(result)).toBe(false);
    expect((result as Verdict).criteria.map(({ number, text, status }) => [number, text, status])).toEqual([
      [1, "fine", "met"],
      [2, "broken", "unmet"],
      [3, "untested", "unverifiable"],
    ]);
  });

  it("names a listed number the verdict left out", () => {
    const result = gradeVerdict(
      parseVerdict({ criteria: [answer(1, "met"), answer(3, "met")], pass: true }),
      LISTED,
    );

    expect(result).toEqual({ missing: [2], unlisted: [], repeated: [] });
  });

  it("names a number the verdict answered that was never listed", () => {
    const result = gradeVerdict(
      parseVerdict({
        criteria: [answer(1, "met"), answer(2, "met"), answer(3, "met"), answer(4, "met")],
        pass: true,
      }),
      LISTED,
    );

    expect(result).toEqual({ missing: [], unlisted: [4], repeated: [] });
  });

  it("names a number the verdict answered twice", () => {
    const result = gradeVerdict(
      parseVerdict({
        criteria: [answer(1, "met"), answer(2, "met"), answer(2, "unmet"), answer(3, "met")],
        pass: true,
      }),
      LISTED,
    );

    expect(result).toEqual({ missing: [], unlisted: [], repeated: [2] });
  });

  it("carries the defects the verdict reported", () => {
    expect(graded(["met"], [{ summary: "it crashes", evidence: "ran it" }]).defects).toEqual([
      { summary: "it crashes", evidence: "ran it" },
    ]);
  });
});

describe("passes", () => {
  it("passes when nothing is unmet and something is met", () => {
    expect(passes(graded(["met", "unverifiable"]))).toBe(true);
  });

  it("ignores the agent's own pass flag when it disagrees", () => {
    expect(passes(graded(["met", "unmet"]))).toBe(false);
  });

  it("fails a verdict where every criterion is unverifiable", () => {
    expect(passes(graded(["unverifiable", "unverifiable"]))).toBe(false);
  });

  it("fails a verdict that reports a defect of the branch, every criterion met", () => {
    expect(passes(graded(["met"], [{ summary: "it crashes", evidence: "ran it" }]))).toBe(false);
  });
});

describe("countStatuses", () => {
  it("counts each status", () => {
    expect(countStatuses(graded(["met", "met", "unmet"]))).toEqual({
      met: 2,
      unmet: 1,
      unverifiable: 0,
    });
  });
});

describe("unmetCriteria", () => {
  it("returns only the criteria a fix Stage would have to address", () => {
    expect(unmetCriteria(graded(["met", "unmet"])).map((c) => c.text)).toEqual(["broken"]);
  });
});

describe("VERDICT_JSON_SCHEMA", () => {
  it("describes the criteria array the verify Stage must emit", () => {
    expect(VERDICT_JSON_SCHEMA).toMatchObject({
      type: "object",
      required: ["criteria", "pass"],
    });
  });

  it("asks for each criterion by its number, and never its text", () => {
    const { items } = VERDICT_JSON_SCHEMA.properties.criteria;

    expect(items.required).toEqual(["number", "status", "evidence"]);
    expect(Object.keys(items.properties)).not.toContain("text");
  });

  it("opens the Notes list beside the criteria, and sends a defect of the branch to the defects", () => {
    expect(VERDICT_JSON_SCHEMA.properties.notes.type).toBe("array");
    expect(VERDICT_JSON_SCHEMA.properties.notes.description).toMatch(/goes in `defects`, not here/);
    expect(VERDICT_JSON_SCHEMA.properties.defects.type).toBe("array");
  });

  it("describes a criterion's evidence as what was run or read and what it showed, proposing no fix", () => {
    const { description } = VERDICT_JSON_SCHEMA.properties.criteria.items.properties.evidence;

    expect(description).toMatch(/^What you ran or read, and what it showed/);
    expect(description).toMatch(/proposes no fix/i);
  });

  it("requires the criteria and the pass flag, and never the Notes or the defects", () => {
    expect(VERDICT_JSON_SCHEMA.required).toEqual(["criteria", "pass"]);
  });
});
