import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tickCriteria, tickMetCriteria } from "./criteria.js";
import { FakeTracker } from "./testing/fakes.js";
import type { Verdict } from "./verdict.js";

const TICKET = 2;

function verdict(...criteria: Verdict["criteria"]): Verdict {
  return { criteria, pass: true };
}

const MET = { status: "met", evidence: "npm test is green" } as const;

/** {@link tickCriteria} over a Ticket that writes everything in one text. */
function tick(text: string, met: string[]): string {
  const [ticked] = tickCriteria([text], met);
  return ticked ?? text;
}

/** #284 as it stood before its merge, and the criteria its final Verdict met. */
const TICKET_284 = {
  body: readFileSync(new URL("./testing/ticket-284/body.md", import.meta.url), "utf8"),
  met: JSON.parse(
    readFileSync(new URL("./testing/ticket-284/final-verdict.json", import.meta.url), "utf8"),
  ) as string[],
};

describe("ticking a criterion", () => {
  it("ticks the box whose text a Verdict met", () => {
    const body = ["## Acceptance criteria", "", "- [ ] it works", "- [ ] it is documented"].join("\n");

    expect(tick(body, ["it works"])).toBe(
      ["## Acceptance criteria", "", "- [x] it works", "- [ ] it is documented"].join("\n"),
    );
  });

  it("leaves every box the Verdict did not name unticked", () => {
    const body = "- [ ] it works\n- [ ] the docs say so";

    expect(tick(body, ["it works"])).toBe("- [x] it works\n- [ ] the docs say so");
  });

  it("keeps the bullet, the indent and the text exactly as they were", () => {
    const body = "  * [ ]   it   works  ";

    expect(tick(body, ["it works"])).toBe("  * [x]   it   works  ");
  });

  it("matches a criterion the verify Stage reported with different spacing or case", () => {
    const body = "- [ ] It works, end to end";

    expect(tick(body, ["it   works,\nend to end"])).toBe("- [x] It works, end to end");
  });

  it("leaves a box already ticked alone", () => {
    const body = "- [x] it works";

    expect(tick(body, ["it works"])).toBe(body);
  });

  it("leaves everything else in the text untouched", () => {
    const body = "Some prose about `- [ ] it works` and then:\n\n- [ ] it works";

    expect(tick(body, ["it works"])).toBe(
      "Some prose about `- [ ] it works` and then:\n\n- [x] it works",
    );
  });

  it("returns the text unchanged when nothing matched, so nothing is written back", () => {
    const body = "- [ ] it works";

    expect(tick(body, ["something else entirely"])).toBe(body);
  });

  it("ticks every box a repeated criterion matches", () => {
    const body = "- [ ] it works\n- [ ] it works";

    expect(tick(body, ["it works"])).toBe("- [x] it works\n- [x] it works");
  });
});

describe("a second chance for a criterion that matches no line exactly", () => {
  it("drops a note the verify Stage appended in parentheses", () => {
    const body = "- [ ] the table reads:\n\n| a | b |\n|---|---|\n";

    expect(tick(body, ["The table reads: (table)"])).toBe(
      "- [x] the table reads:\n\n| a | b |\n|---|---|\n",
    );
  });

  it("drops only one parenthetical, and only at the end", () => {
    const body = "- [ ] it works";

    expect(tick(body, ["it works (fast) (today)"])).toBe(body);
    expect(tick(body, ["it works (fast) today"])).toBe(body);
  });

  it("reads three dots as any run of characters", () => {
    const body = "- [ ] it works on Linux, macOS and Windows alike";

    expect(tick(body, ["it works on ... and Windows ..."])).toBe(
      "- [x] it works on Linux, macOS and Windows alike",
    );
  });

  it("reads an ellipsis character as any run of characters", () => {
    const body = "- [ ] it works on Linux, macOS and Windows alike";

    expect(tick(body, ["it works on Linux…alike"])).toBe(
      "- [x] it works on Linux, macOS and Windows alike",
    );
  });

  it("reads everything but the dots literally", () => {
    const body = "- [ ] a+b costs $5, paid by card";

    expect(tick(body, ["a+b costs $5 ... card"])).toBe("- [x] a+b costs $5, paid by card");
    expect(tick(body, ["a.b costs ... card"])).toBe(body);
  });

  it("reads dots and a dropped parenthetical in the same criterion", () => {
    const body = "- [ ] the block reads, in order:\n\n```\nblock\n```\n";

    expect(tick(body, ["the block reads ... order: (the block in the body)"])).toBe(
      "- [x] the block reads, in order:\n\n```\nblock\n```\n",
    );
  });

  it("keeps the parenthetical where the line ends with one too", () => {
    const body = "- [ ] it works on Linux and Windows (both)";

    expect(tick(body, ["it works on ... (both)"])).toBe(
      "- [x] it works on Linux and Windows (both)",
    );
  });

  it("ticks neither of two lines the second chance matches", () => {
    const body = "- [ ] it works on Linux\n- [ ] it works on Windows";

    expect(tick(body, ["it works on ..."])).toBe(body);
  });

  it("ticks nothing when the second chance matches no line either", () => {
    const body = "- [ ] it works on Linux";

    expect(tick(body, ["it fails on ..."])).toBe(body);
  });

  it("offers only the lines the exact matches left unticked", () => {
    const body = "- [ ] it works on Linux\n- [ ] it works on Windows";

    expect(tick(body, ["it works on Linux", "it works on ..."])).toBe(
      "- [x] it works on Linux\n- [x] it works on Windows",
    );
  });

  it("gives no second chance to a criterion that matches a line exactly", () => {
    const body = "- [ ] it works (fast)\n- [ ] it works";

    expect(tick(body, ["it works (fast)"])).toBe("- [x] it works (fast)\n- [ ] it works");
  });

  it("gives no second chance to a criterion whose line is already ticked", () => {
    const body = "- [x] it works (fast)\n- [ ] it works";

    expect(tick(body, ["it works (fast)"])).toBe(body);
  });

  it("gives none to a criterion that is all dots and parentheses", () => {
    const body = "- [ ] it works";

    expect(tick(body, ["..."])).toBe(body);
    expect(tick(body, ["(everything)"])).toBe(body);
  });

  it("counts the lines of every text together", () => {
    const texts = ["- [ ] it works on Linux", "Brief:\n\n- [ ] it works on Windows"];

    expect(tickCriteria(texts, ["it works on ..."])).toEqual(texts);
    expect(tickCriteria(texts, ["it works on L..."])).toEqual([
      "- [x] it works on Linux",
      "Brief:\n\n- [ ] it works on Windows",
    ]);
  });

  it("ticks all 9 of #284's boxes from its final Verdict", () => {
    const ticked = tick(TICKET_284.body, TICKET_284.met);

    expect(ticked.match(/^- \[x\] /gm)).toHaveLength(9);
    expect(ticked.match(/^- \[ \] /gm)).toBeNull();
    expect(ticked.replaceAll(/^- \[x\] /gm, "- [ ] ")).toBe(TICKET_284.body);
  });

  it("ticks #284's longest criterion to its own line with three passages cut", () => {
    const long = TICKET_284.met.find((text) => text.length === 726);
    if (long === undefined) throw new Error("#284's 726-character criterion is missing");
    const cut = long
      .replace(/^(Text this Ticket adds writes none of these in capitals, ).*?(: Execution)/, "$1...$2")
      .replace(/(Version notes, ).*?(\. A word)/, "$1...$2")
      .replace(/(\(Run lock, ).*?( verify Stage\))/, "$1...$2");
    expect(cut.split("...")).toHaveLength(4);

    const ticked = tick(TICKET_284.body, [cut]);

    expect(ticked.match(/^- \[x\] .*/gm)).toEqual([`- [x] ${long}`]);
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

  it("gives a second chance across the body and every comment together", async () => {
    const tracker = new FakeTracker();
    const issue = tracker.addIssue({ number: TICKET, body: "- [ ] it works on Linux\n" });
    issue.comments.push({ id: "77", body: "Brief:\n\n- [ ] it works on Windows\n" });
    const lines: string[] = [];

    await tickMetCriteria(
      tracker,
      TICKET,
      verdict({ text: "it works on ...", ...MET }),
      (line) => lines.push(line),
    );

    expect(tracker.calls).not.toContain(`updateIssueBody:${TICKET}`);
    expect(tracker.updatedComments).toEqual([]);
    expect(lines).toEqual([
      `#${TICKET} ticked 0 of 1 met criteria; the rest match no checkbox on the Ticket`,
    ]);
  });

  it("ticks a comment's line the second chance found, and counts it", async () => {
    const tracker = new FakeTracker();
    const issue = tracker.addIssue({ number: TICKET, body: "- [ ] it works on Linux\n" });
    issue.comments.push({ id: "77", body: "Brief:\n\n- [ ] it works on Windows\n" });
    const lines: string[] = [];

    await tickMetCriteria(
      tracker,
      TICKET,
      verdict({ text: "it works on Linux", ...MET }, { text: "it works on W...", ...MET }),
      (line) => lines.push(line),
    );

    expect(tracker.issue(TICKET).body).toBe("- [x] it works on Linux\n");
    expect(tracker.updatedComments).toEqual([
      { id: "77", body: "Brief:\n\n- [x] it works on Windows\n" },
    ]);
    expect(lines).toEqual([]);
  });
});
