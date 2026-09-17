import { describe, expect, it } from "vitest";
import { tickCriteria, tickMetCriteria } from "./criteria.js";
import { FakeTracker } from "./testing/fakes.js";
import type { Verdict } from "./verdict.js";

const TICKET = 2;

function verdict(...criteria: Verdict["criteria"]): Verdict {
  return { criteria, pass: true };
}

const MET = { status: "met", evidence: "npm test is green" } as const;

describe("ticking a criterion", () => {
  it("ticks the box whose text a Verdict met", () => {
    const body = ["## Acceptance criteria", "", "- [ ] it works", "- [ ] it is documented"].join("\n");

    expect(tickCriteria(body, ["it works"])).toBe(
      ["## Acceptance criteria", "", "- [x] it works", "- [ ] it is documented"].join("\n"),
    );
  });

  it("leaves every box the Verdict did not name unticked", () => {
    const body = "- [ ] it works\n- [ ] the docs say so";

    expect(tickCriteria(body, ["it works"])).toBe("- [x] it works\n- [ ] the docs say so");
  });

  it("keeps the bullet, the indent and the text exactly as they were", () => {
    const body = "  * [ ]   it   works  ";

    expect(tickCriteria(body, ["it works"])).toBe("  * [x]   it   works  ");
  });

  it("matches a criterion the verify Stage reported with different spacing or case", () => {
    const body = "- [ ] It works, end to end";

    expect(tickCriteria(body, ["it   works,\nend to end"])).toBe("- [x] It works, end to end");
  });

  it("leaves a box already ticked alone", () => {
    const body = "- [x] it works";

    expect(tickCriteria(body, ["it works"])).toBe(body);
  });

  it("leaves everything else in the text untouched", () => {
    const body = "Some prose about `- [ ] it works` and then:\n\n- [ ] it works";

    expect(tickCriteria(body, ["it works"])).toBe(
      "Some prose about `- [ ] it works` and then:\n\n- [x] it works",
    );
  });

  it("returns the text unchanged when nothing matched, so nothing is written back", () => {
    const body = "- [ ] it works";

    expect(tickCriteria(body, ["something else entirely"])).toBe(body);
  });

  it("ticks every box a repeated criterion matches", () => {
    const body = "- [ ] it works\n- [ ] it works";

    expect(tickCriteria(body, ["it works"])).toBe("- [x] it works\n- [x] it works");
  });
});

describe("ticking what a merge proved", () => {
  it("ticks the met criteria in the body and leaves the unverifiable ones", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: TICKET, body: "- [ ] it works\n- [ ] the docs say so\n" });

    await tickMetCriteria(
      tracker,
      TICKET,
      verdict(
        { text: "it works", ...MET },
        { text: "the docs say so", status: "unverifiable", evidence: "not readable from here" },
      ),
    );

    expect(tracker.issue(TICKET).body).toBe("- [x] it works\n- [ ] the docs say so\n");
  });

  it("ticks criteria a comment carries instead of the body", async () => {
    const tracker = new FakeTracker();
    const issue = tracker.addIssue({ number: TICKET, body: "no criteria here" });
    issue.comments.push({ id: "77", body: "Brief:\n\n- [ ] it works\n" });

    await tickMetCriteria(tracker, TICKET, verdict({ text: "it works", ...MET }));

    expect(tracker.updatedComments).toEqual([{ id: "77", body: "Brief:\n\n- [x] it works\n" }]);
    expect(tracker.calls).not.toContain(`updateIssueBody:${TICKET}`);
  });

  it("writes nothing when the Verdict proved nothing the Ticket wrote down", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: TICKET, body: "- [ ] something nobody graded\n" });

    await tickMetCriteria(tracker, TICKET, verdict({ text: "it works", ...MET }));

    expect(tracker.calls).not.toContain(`updateIssueBody:${TICKET}`);
  });

  it("says so when a criterion matched no checkbox, rather than leaving a mystery", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: TICKET, body: "- [ ] it works\n" });
    const lines: string[] = [];

    await tickMetCriteria(
      tracker,
      TICKET,
      verdict({ text: "it works", ...MET }, { text: "reworded past recognition", ...MET }),
      (line) => lines.push(line),
    );

    expect(lines).toEqual([
      `#${TICKET} ticked 1 of 2 met criteria; the rest match no checkbox on the Ticket`,
    ]);
  });

  it("leaves a comment it has no id for alone", async () => {
    const tracker = new FakeTracker();
    const issue = tracker.addIssue({ number: TICKET, body: "no criteria here" });
    issue.comments.push({ body: "- [ ] it works\n" });

    await tickMetCriteria(tracker, TICKET, verdict({ text: "it works", ...MET }));

    expect(tracker.updatedComments).toEqual([]);
  });
});
