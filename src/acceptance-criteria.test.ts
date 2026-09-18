import { describe, expect, it } from "vitest";
import { UNCHECKED_BOX } from "./acceptance-criteria.js";
import { tickCriteria } from "./criteria.js";
import { skipReason } from "./guards.js";
import type { Issue } from "./ports/tracker.js";
import { noteComment } from "./templates.js";

const READY = "ready-for-agent";

/** A Ticket whose only interesting part is the text its criteria are written in. */
function ticket(body: string): Issue {
  return {
    number: 37,
    title: "The shape of an Acceptance Criterion",
    url: "https://github.com/acme/repo/issues/37",
    body,
    closed: false,
    labels: [READY],
    assignees: [],
    subIssues: 0,
    blockedBy: [],
    comments: [],
  };
}

/** What the `no-criteria` guard makes of a text: the reader the other two follow. */
function guardCountsCriteria(text: string): boolean {
  return skipReason(ticket(text), READY, false) !== "no-criteria";
}

/** A Note carrying `text`, as the escaper leaves it for a human to read. */
function posted(text: string): string {
  return noteComment({ origin: 10, stage: "implement", note: text });
}

/**
 * Every shape the three readers have to agree on, and one they must all refuse.
 * The criterion text is the same throughout so a disagreement is about the head
 * of the line, which is the part {@link UNCHECKED_BOX} defines.
 */
const CRITERIA = [
  "- [ ] it works",
  "* [ ] it works",
  "+ [ ] it works",
  "  - [ ] it works",
  "\t- [ ] it works",
  "prose above\n- [ ] it works\nprose below",
];
const NOT_CRITERIA = ["- [x] it works", "-[ ] it works", "a - [ ] it works", "[ ] it works"];

describe("the shape the guard, the ticker and the Note escaper share", () => {
  it.each(CRITERIA)("is counted by the guard in %j", (text) => {
    expect(guardCountsCriteria(text)).toBe(true);
  });

  it.each(CRITERIA)("is ticked by the merge in %j", (text) => {
    expect(tickCriteria(text, ["it works"])).toContain("[x] it works");
  });

  it.each(CRITERIA)("is defused by a Note in %j", (text) => {
    expect(posted(text)).toContain("\\[ \\] it works");
    expect(guardCountsCriteria(posted(text))).toBe(false);
  });

  it.each(NOT_CRITERIA)("is not read into %j by any of the three", (text) => {
    expect(guardCountsCriteria(text)).toBe(false);
    expect(tickCriteria(text, ["it works"])).toBe(text);
    expect(posted(text)).toContain(text);
  });
});

describe("the definition itself", () => {
  it("anchors to the head of a line, so a box in prose is prose", () => {
    expect(new RegExp(UNCHECKED_BOX, "m").test("the box - [ ] is mid-sentence")).toBe(false);
  });

  it("captures the indent and bullet, which a rewrite puts back untouched", () => {
    expect("  * [ ] it works".match(new RegExp(UNCHECKED_BOX, "m"))?.[1]).toBe("  * ");
  });
});
