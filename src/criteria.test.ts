import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ListedCriterion, listCriteria } from "./acceptance-criteria.js";
import { tickCriteria, tickMetCriteria } from "./criteria.js";
import { FakeTracker } from "./testing/fakes.js";
import type { CriterionStatus, Verdict } from "./verdict.js";

const TICKET = 2;

/** A verdict giving each criterion listed from `texts` the status its number picks, `met` by default. */
function verdict(
  texts: string[],
  statuses: Record<number, CriterionStatus> = {},
): Verdict {
  return {
    criteria: listCriteria(texts).map((criterion) => ({
      ...criterion,
      status: statuses[criterion.number] ?? "met",
      evidence: "npm test is green",
    })),
    defects: [],
  };
}

/** {@link tickCriteria} over a Ticket that writes everything in one text, ticking the criteria `numbers` name. */
function tick(text: string, numbers: number[], listedFrom = text): string {
  const met = listCriteria([listedFrom]).filter(({ number }) => numbers.includes(number));
  const [ticked] = tickCriteria([text], met).texts;
  return ticked ?? text;
}

/** #284 as it stood before its merge: a long criterion with a block under it, and a table under another. */
const BODY_284 = readFileSync(new URL("./testing/ticket-284/body.md", import.meta.url), "utf8");

describe("listing the criteria for verify", () => {
  it("numbers the unticked boxes of the body and then of each comment, in order", () => {
    const listed = listCriteria(["- [ ] one\n- [x] done\n- [ ] two", "Brief:\n\n- [ ] three"]);

    expect(listed.map(({ number, text }) => [number, text])).toEqual([
      [1, "one"],
      [2, "two"],
      [3, "three"],
    ]);
  });

  it("keeps the checkbox line exactly as the Ticket wrote it", () => {
    const [listed] = listCriteria(["  * [ ]   it   works  "]);

    expect(listed?.line).toBe("  * [ ]   it   works  ");
    expect(listed?.text).toBe("it   works");
  });

  it("gives a criterion the indented lines under its checkbox", () => {
    const [listed] = listCriteria([
      "- [ ] the table reads:\n\n  | a | b |\n  |---|---|\n\n- [ ] next",
    ]);

    expect(listed?.details).toEqual(["", "  | a | b |", "  |---|---|"]);
  });

  it("ends a criterion's lines at the first line indented no further than its box", () => {
    const [listed] = listCriteria(["- [ ] it works\n  on Linux\nprose\n  not its own"]);

    expect(listed?.details).toEqual(["  on Linux"]);
  });

  it("gives a nested checkbox a number of its own, and its lines to it alone", () => {
    const listed = listCriteria([
      "- [ ] parent\n  under the parent\n  - [ ] child\n    under the child\n  - [x] ticked child\n    under the ticked one\n  back under the parent",
    ]);

    expect(listed.map(({ number, text, details }) => ({ number, text, details }))).toEqual([
      { number: 1, text: "parent", details: ["  under the parent", "  back under the parent"] },
      { number: 2, text: "child", details: ["    under the child"] },
    ]);
  });

  it("lists every criterion of #284, with the block under its first", () => {
    const listed = listCriteria([BODY_284]);

    expect(listed).toHaveLength(9);
    expect(listed[0]?.details.join("\n")).toContain("**Stranded Ticket**:");
    expect(listed[5]?.details.join("\n")).toContain("| fix budget | fix 기회 |");
    expect(listed[1]?.details).toEqual([]);
  });
});

describe("ticking a criterion by its number", () => {
  it("ticks the box of each number the verdict met", () => {
    const body = ["## Acceptance criteria", "", "- [ ] it works", "- [ ] it is documented"].join("\n");

    expect(tick(body, [1])).toBe(
      ["## Acceptance criteria", "", "- [x] it works", "- [ ] it is documented"].join("\n"),
    );
  });

  it("keeps the bullet, the indent and the text exactly as they were", () => {
    const body = "  * [ ]   it   works  ";

    expect(tick(body, [1])).toBe("  * [x]   it   works  ");
  });

  it("leaves everything else in the text untouched", () => {
    const body = "Some prose about `- [ ] it works` and then:\n\n- [ ] it works";

    expect(tick(body, [1])).toBe("Some prose about `- [ ] it works` and then:\n\n- [x] it works");
  });

  it("ticks a criterion whose line moved, as long as one line still reads as it", () => {
    const listedFrom = "- [ ] it works\n- [ ] it is documented";
    const edited = "- [ ] a criterion added since\n- [ ] it works\n- [ ] it is documented";

    expect(tick(edited, [2], listedFrom)).toBe(
      "- [ ] a criterion added since\n- [ ] it works\n- [x] it is documented",
    );
  });

  it("ticks nothing for a criterion whose line was reworded since it was listed", () => {
    const listedFrom = "- [ ] it works";
    const edited = "- [ ] it works on Linux";

    const { texts, untickable } = tickCriteria([edited], listCriteria([listedFrom]));

    expect(texts).toEqual([edited]);
    expect(untickable).toEqual([{ number: 1, lines: 0 }]);
  });

  it("ticks neither of two lines that both read as the criterion's", () => {
    const body = "- [ ] it works\n- [ ] it works";

    const { texts, untickable } = tickCriteria([body], listCriteria([body]));

    expect(texts).toEqual([body]);
    expect(untickable).toEqual([
      { number: 1, lines: 2 },
      { number: 2, lines: 2 },
    ]);
  });

  it("counts the lines of every text together", () => {
    const listed = listCriteria(["- [ ] it works"]);

    const { texts, untickable } = tickCriteria(["- [ ] it works", "- [ ] it works"], listed);

    expect(texts).toEqual(["- [ ] it works", "- [ ] it works"]);
    expect(untickable).toEqual([{ number: 1, lines: 2 }]);
  });

  it("leaves a box a human ticked since alone, and says it found no line", () => {
    const listed = listCriteria(["- [ ] it works"]);

    expect(tickCriteria(["- [x] it works"], listed).untickable).toEqual([{ number: 1, lines: 0 }]);
  });

  it("ticks every box of #284 its verdict met, sub-lists, escapes and all", () => {
    const listed = listCriteria([BODY_284]);

    const [ticked = ""] = tickCriteria([BODY_284], listed).texts;

    expect(ticked.match(/^- \[ \]/gm)).toBeNull();
    expect(ticked.match(/^- \[x\]/gm)).toHaveLength(9);
  });
});

describe("ticking what a merge proved", () => {
  it("ticks the met criteria in the body and leaves the unverifiable ones", async () => {
    const tracker = new FakeTracker();
    const body = "- [ ] it works\n- [ ] the docs say so\n";
    tracker.addIssue({ number: TICKET, body });

    await tickMetCriteria(tracker, TICKET, verdict([body], { 2: "unverifiable" }));

    expect(tracker.issue(TICKET).body).toBe("- [x] it works\n- [ ] the docs say so\n");
  });

  it("ticks criteria a comment carries instead of the body", async () => {
    const tracker = new FakeTracker();
    const issue = tracker.addIssue({ number: TICKET, body: "no criteria here" });
    issue.comments.push({ id: "77", body: "Brief:\n\n- [ ] it works\n" });

    await tickMetCriteria(tracker, TICKET, verdict(["no criteria here", "Brief:\n\n- [ ] it works\n"]));

    expect(tracker.updatedComments).toEqual([{ id: "77", body: "Brief:\n\n- [x] it works\n" }]);
    expect(tracker.calls).not.toContain(`updateIssueBody:${TICKET}`);
  });

  it("writes nothing and says so when no line reads as a met criterion's any more", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: TICKET, body: "- [ ] it works\n- [ ] it was reworded since\n" });
    const lines: string[] = [];

    await tickMetCriteria(
      tracker,
      TICKET,
      verdict(["- [ ] it works\n- [ ] it said this when verify got it\n"]),
      (line) => lines.push(line),
    );

    expect(tracker.issue(TICKET).body).toBe("- [x] it works\n- [ ] it was reworded since\n");
    expect(lines).toEqual([
      `#${TICKET} ticked 1 of 2 met criteria; left unticked: criterion 2, which no unticked line reads as any more`,
    ]);
  });

  it("says so when more than one line reads as a met criterion's", async () => {
    const tracker = new FakeTracker();
    const issue = tracker.addIssue({ number: TICKET, body: "- [ ] it works\n" });
    issue.comments.push({ id: "77", body: "- [ ] it works\n" });
    const lines: string[] = [];

    await tickMetCriteria(tracker, TICKET, verdict(["- [ ] it works\n"]), (line) => lines.push(line));

    expect(tracker.calls).not.toContain(`updateIssueBody:${TICKET}`);
    expect(tracker.updatedComments).toEqual([]);
    expect(lines).toEqual([
      `#${TICKET} ticked 0 of 1 met criteria; left unticked: criterion 1, which 2 unticked lines read as`,
    ]);
  });

  it("leaves a comment it has no id for alone, and says so", async () => {
    const tracker = new FakeTracker();
    const issue = tracker.addIssue({ number: TICKET, body: "no criteria here" });
    issue.comments.push({ body: "- [ ] it works\n" });
    const lines: string[] = [];

    await tickMetCriteria(
      tracker,
      TICKET,
      verdict(["no criteria here", "- [ ] it works\n"]),
      (line) => lines.push(line),
    );

    expect(tracker.updatedComments).toEqual([]);
    expect(lines).toEqual([
      `#${TICKET} ticked 0 of 1 met criteria; left unticked: criterion 1, in a comment it cannot edit`,
    ]);
  });

  it("matches nothing against what the verify Stage wrote", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: TICKET, body: "- [ ] it works\n" });
    const graded: ListedCriterion & { status: "met"; evidence: string } = {
      number: 1,
      line: "- [ ] it works",
      text: "an entirely different copy of it",
      details: [],
      status: "met",
      evidence: "green",
    };

    await tickMetCriteria(tracker, TICKET, { criteria: [graded], defects: [] });

    expect(tracker.issue(TICKET).body).toBe("- [x] it works\n");
  });
});
