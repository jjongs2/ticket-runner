import { describe, expect, it } from "vitest";
import { NOTES_LIST_SCHEMA } from "./note-schema.js";
import { CODE_STAGE_JSON_SCHEMA } from "./title.js";
import { VERDICT_JSON_SCHEMA } from "./verdict.js";

describe("NOTES_LIST_SCHEMA", () => {
  it("asks for a ticket and a Note's parts, and requires all but the ticket and next", () => {
    expect(Object.keys(NOTES_LIST_SCHEMA.items.properties)).toEqual([
      "ticket",
      "summary",
      "evidence",
      "impact",
      "next",
    ]);
    expect(NOTES_LIST_SCHEMA.items.required).toEqual(["summary", "evidence", "impact"]);
  });

  it("says what goes in each part", () => {
    const { summary, evidence, impact, next } = NOTES_LIST_SCHEMA.items.properties;

    expect(summary.description).toContain("One short sentence naming the defect");
    expect(evidence.description).toContain("what shows it is real");
    expect(evidence.description).toContain("what you expected and what came back");
    expect(impact.description).toContain("What breaks, and for whom");
    expect(next.description).toContain("the decision a human has to take");
    expect(next.description).toContain("Leave it out when there is neither");
  });

  it("promises a Stage nothing about issue titles", () => {
    expect(NOTES_LIST_SCHEMA.items.properties.summary.description).not.toContain("title");
  });

  it("is the one declaration both the Stages that write and the one that grades read", () => {
    expect(CODE_STAGE_JSON_SCHEMA.properties.notes).toBe(NOTES_LIST_SCHEMA);
    expect(VERDICT_JSON_SCHEMA.properties.notes).toBe(NOTES_LIST_SCHEMA);
  });
});
