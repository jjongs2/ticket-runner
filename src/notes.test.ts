import { describe, expect, it } from "vitest";
import { NOTES_JSON_SCHEMA, StandingNotes, parseNotes, routeNotes } from "./notes.js";
import { NOTES_ISSUE_MARKER, NOTES_ISSUE_TITLE } from "./templates.js";
import { FakeTracker } from "./testing/fakes.js";

const ORIGIN = 10;

/** The number the fake gives the first issue the pipeline opens itself. */
const OPENED = 200;

function routing(tracker: FakeTracker, log?: (line: string) => void) {
  return {
    tracker,
    origin: ORIGIN,
    stage: "implement" as const,
    needsTriage: "needs-triage",
    inProgress: "in-progress",
    standing: new StandingNotes(),
    ...(log === undefined ? {} : { log }),
  };
}

/** A standing Notes issue already on the Target, as a past Run left it. */
function seedStandingNotes(
  tracker: FakeTracker,
  overrides: { number?: number; title?: string; body?: string; closed?: boolean } = {},
): number {
  const number = overrides.number ?? 50;
  tracker.addIssue({
    number,
    title: overrides.title ?? NOTES_ISSUE_TITLE,
    body: overrides.body ?? `${NOTES_ISSUE_MARKER}\n**Notes from the pipeline.**\n`,
    labels: ["needs-triage"],
    ...(overrides.closed === undefined ? {} : { closed: overrides.closed }),
  });
  return number;
}

describe("parseNotes", () => {
  it("reads the notes out of a Stage's structured output", () => {
    expect(parseNotes({ notes: [{ ticket: 7, note: "the help text drifts" }] })).toEqual([
      { ticket: 7, note: "the help text drifts" },
    ]);
  });

  it("reads a note that names no Ticket", () => {
    expect(parseNotes({ notes: [{ note: "nothing cleans up worktrees" }] })).toEqual([
      { note: "nothing cleans up worktrees" },
    ]);
  });

  it("finds no notes in output that has none", () => {
    expect(parseNotes({ notes: [] })).toEqual([]);
    expect(parseNotes({})).toEqual([]);
  });

  it("finds no notes in output that is not there at all", () => {
    expect(parseNotes(undefined)).toEqual([]);
    expect(parseNotes("done")).toEqual([]);
    expect(parseNotes(null)).toEqual([]);
  });

  it("drops a note with nothing in it", () => {
    expect(parseNotes({ notes: [{ note: "   " }, { note: "real" }] })).toEqual([
      { note: "real" },
    ]);
  });

  it("drops an entry with no words in it and keeps the rest", () => {
    const notes = parseNotes({ notes: [{ note: "first" }, { note: 42 }, { note: "third" }] });

    expect(notes).toEqual([{ note: "first" }, { note: "third" }]);
  });

  it("keeps a note whose ticket number is unusable, minus the number", () => {
    const notes = parseNotes({
      notes: [{ ticket: "eight", note: "a" }, { ticket: 0, note: "b" }, { ticket: 1.5, note: "c" }],
    });

    expect(notes).toEqual([{ note: "a" }, { note: "b" }, { note: "c" }]);
  });

  it("asks for a ticket and a note, and requires only the note", () => {
    const item = NOTES_JSON_SCHEMA.properties.notes.items;

    expect(Object.keys(item.properties)).toEqual(["ticket", "note"]);
    expect(item.required).toEqual(["note"]);
  });

  it("promises a Stage nothing about issue titles", () => {
    expect(NOTES_JSON_SCHEMA.properties.notes.items.properties.note.description).not.toContain(
      "title",
    );
  });
});

describe("routing a Note that names a Ticket", () => {
  it("comments on that Ticket, marker first", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: 7 });

    await routeNotes(routing(tracker), { notes: [{ ticket: 7, note: "the help drifts" }] });

    expect(tracker.comments).toEqual([
      {
        issue: 7,
        body: "<!-- agent-pipeline:note -->\nFrom #10 implement\n\nthe help drifts\n",
      },
    ]);
  });

  it("opens no issue for it", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: 7 });

    await routeNotes(routing(tracker), { notes: [{ ticket: 7, note: "the help drifts" }] });

    expect(tracker.createdIssues).toEqual([]);
  });

  it("reports where it went", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: 7 });

    const routed = await routeNotes(routing(tracker), {
      notes: [{ ticket: 7, note: "the help drifts" }],
    });

    expect(routed).toEqual([
      { origin: ORIGIN, stage: "implement", issue: 7, opened: false, note: "the help drifts" },
    ]);
  });
});

describe("routing a Note that names the Ticket it came from", () => {
  it("sends it to triage rather than commenting on a Ticket that is closing", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: ORIGIN });

    const routed = await routeNotes(routing(tracker), {
      notes: [{ ticket: ORIGIN, note: "the flag needs renaming" }],
    });

    expect(tracker.comments.map((comment) => comment.issue)).toEqual([OPENED]);
    expect(routed).toEqual([
      {
        origin: ORIGIN,
        stage: "implement",
        issue: OPENED,
        opened: true,
        note: "the flag needs renaming",
      },
    ]);
  });
});

describe("routing a Note that names no Ticket", () => {
  it("comments it on the standing Notes issue", async () => {
    const tracker = new FakeTracker();

    await routeNotes(routing(tracker), {
      notes: [{ note: "Nothing cleans up abandoned worktrees. A Run leaks one per hand-off." }],
    });

    expect(tracker.comments).toEqual([
      {
        issue: OPENED,
        body:
          "<!-- agent-pipeline:note -->\nFrom #10 implement\n\n" +
          "Nothing cleans up abandoned worktrees. A Run leaks one per hand-off.\n",
      },
    ]);
  });

  it("opens the standing Notes issue when none is open, under needs-triage", async () => {
    const tracker = new FakeTracker();

    await routeNotes(routing(tracker), { notes: [{ note: "no cleanup" }] });

    expect(tracker.createdIssues).toHaveLength(1);
    expect(tracker.createdIssues[0]).toMatchObject({
      title: NOTES_ISSUE_TITLE,
      labels: ["needs-triage"],
    });
    expect(tracker.createdIssues[0]?.body).toContain(NOTES_ISSUE_MARKER);
  });

  it("opens one issue for many Notes, and says which of them opened it", async () => {
    const tracker = new FakeTracker();

    const routed = await routeNotes(routing(tracker), {
      notes: [{ note: "first" }, { note: "second" }, { note: "third" }],
    });

    expect(tracker.createdIssues).toHaveLength(1);
    expect(routed.map((note) => ({ issue: note.issue, opened: note.opened }))).toEqual([
      { issue: OPENED, opened: true },
      { issue: OPENED, opened: false },
      { issue: OPENED, opened: false },
    ]);
  });

  it("opens no issue at all when one is already standing", async () => {
    const tracker = new FakeTracker();
    const standing = seedStandingNotes(tracker);

    const routed = await routeNotes(routing(tracker), { notes: [{ note: "no cleanup" }] });

    expect(tracker.createdIssues).toEqual([]);
    expect(routed).toEqual([
      { origin: ORIGIN, stage: "implement", issue: standing, opened: false, note: "no cleanup" },
    ]);
  });

  it("opens it under the fixed title, never one taken from the Note", async () => {
    const tracker = new FakeTracker();

    await routeNotes(routing(tracker), { notes: [{ note: "Worktrees are never cleaned up." }] });

    expect(tracker.createdIssues[0]?.title).toBe(NOTES_ISSUE_TITLE);
  });

  it("never writes over the standing Notes issue's body", async () => {
    const tracker = new FakeTracker();
    seedStandingNotes(tracker);

    await routeNotes(routing(tracker), { notes: [{ note: "no cleanup" }, { note: "again" }] });

    expect(tracker.calls.filter((call) => call.startsWith("updateIssueBody"))).toEqual([]);
  });
});

describe("finding the standing Notes issue", () => {
  it("confirms the title with the marker before it writes", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({
      number: 50,
      title: NOTES_ISSUE_TITLE,
      body: "A human wrote this one and it is not the pipeline's.",
      labels: ["needs-triage"],
    });

    const routed = await routeNotes(routing(tracker), { notes: [{ note: "no cleanup" }] });

    expect(routed[0]?.issue).toBe(OPENED);
    expect(tracker.comments.map((comment) => comment.issue)).toEqual([OPENED]);
  });

  it("finds one a human renamed, by its marker, and opens no second one", async () => {
    const tracker = new FakeTracker();
    const standing = seedStandingNotes(tracker, { title: "Pipeline inbox (read me first)" });

    const routed = await routeNotes(routing(tracker), { notes: [{ note: "no cleanup" }] });

    expect(tracker.createdIssues).toEqual([]);
    expect(routed[0]?.issue).toBe(standing);
    expect(tracker.issue(standing).title).toBe("Pipeline inbox (read me first)");
  });

  it("ignores one that is closed and opens a fresh one", async () => {
    const tracker = new FakeTracker();
    seedStandingNotes(tracker, { closed: true });

    const routed = await routeNotes(routing(tracker), { notes: [{ note: "no cleanup" }] });

    expect(routed[0]?.issue).toBe(OPENED);
    expect(tracker.createdIssues).toHaveLength(1);
  });

  it("looks under the label this Target calls needs-triage", async () => {
    const tracker = new FakeTracker();
    const routed = { ...routing(tracker), needsTriage: "inbox" };

    await routeNotes(routed, { notes: [{ note: "no cleanup" }] });

    expect(tracker.calls).toContain("listCandidates:inbox");
    expect(tracker.createdIssues[0]?.labels).toEqual(["inbox"]);
  });

  it("looks once however many Notes a Run writes", async () => {
    const tracker = new FakeTracker();
    seedStandingNotes(tracker);
    const shared = routing(tracker);

    await routeNotes(shared, { notes: [{ note: "first" }, { note: "second" }] });
    await routeNotes({ ...shared, stage: "fix" }, { notes: [{ note: "third" }] });

    expect(tracker.calls.filter((call) => call === "listCandidates:needs-triage")).toHaveLength(1);
  });

  it("opens at most one when two Lanes route Notes at the same time", async () => {
    const tracker = new FakeTracker();
    const shared = routing(tracker);

    const [left, right] = await Promise.all([
      routeNotes({ ...shared, origin: 4 }, { notes: [{ note: "from one Lane" }] }),
      routeNotes({ ...shared, origin: 5 }, { notes: [{ note: "from the other" }] }),
    ]);

    expect(tracker.createdIssues).toHaveLength(1);
    expect([left[0]?.issue, right[0]?.issue]).toEqual([OPENED, OPENED]);
    expect([left[0]?.opened, right[0]?.opened].filter(Boolean)).toEqual([true]);
  });
});

describe("what a Stage is told about the standing Notes issue", () => {
  it("is the number when one is open", async () => {
    const tracker = new FakeTracker();
    const standing = seedStandingNotes(tracker);

    expect(
      await new StandingNotes().current({ tracker, needsTriage: "needs-triage" }),
    ).toBe(standing);
  });

  it("is nothing when none is, and opens none to answer", async () => {
    const tracker = new FakeTracker();

    expect(
      await new StandingNotes().current({ tracker, needsTriage: "needs-triage" }),
    ).toBeUndefined();
    expect(tracker.createdIssues).toEqual([]);
  });

  it("is the one this Run opened, once a Note has needed it", async () => {
    const tracker = new FakeTracker();
    const shared = routing(tracker);

    await routeNotes(shared, { notes: [{ note: "no cleanup" }] });

    expect(await shared.standing.current(shared)).toBe(OPENED);
  });

  it("is nothing when the lookup itself fails, rather than a failed Stage", async () => {
    const tracker = new FakeTracker();
    tracker.listCandidates = async () => {
      throw new Error("gh: connection reset");
    };
    const lines: string[] = [];

    const current = await new StandingNotes().current({
      tracker,
      needsTriage: "needs-triage",
      log: (line) => lines.push(line),
    });

    expect(current).toBeUndefined();
    expect(lines.join("\n")).toContain("could not look up the standing Notes issue");
  });
});

describe("escaping", () => {
  it("escapes a checkbox in a Note it comments", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: 7 });

    await routeNotes(routing(tracker), {
      notes: [{ ticket: 7, note: "two things:\n- [ ] one\n  - [ ] two" }],
    });

    expect(tracker.comments[0]?.body).toContain("- \\[ \\] one\n  - \\[ \\] two");
  });

  it("escapes a checkbox in a Note it sends to triage", async () => {
    const tracker = new FakeTracker();

    await routeNotes(routing(tracker), { notes: [{ note: "todo\n* [ ] one" }] });

    expect(tracker.comments[0]?.body).toContain("* \\[ \\] one");
  });

  it("leaves a bracket that is not a checkbox alone", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: 7 });

    await routeNotes(routing(tracker), {
      notes: [{ ticket: 7, note: "the guard reads `- [ ]` as criteria" }],
    });

    expect(tracker.comments[0]?.body).toContain("the guard reads `- [ ]` as criteria");
  });
});

describe("routing a Note that names a Ticket nobody will read again", () => {
  it.each([
    ["closed", { closed: true }, "is closed"],
    ["claimed", { labels: ["in-progress"] }, "is claimed"],
    ["a Spec", { subIssues: 2 }, "is a Spec"],
  ])("sends a Note to triage when the Ticket it named is %s", async (_, shape, why) => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: 7, ...shape });
    const lines: string[] = [];

    const routed = await routeNotes(routing(tracker, (line) => lines.push(line)), {
      notes: [{ ticket: 7, note: "the help drifts" }],
    });

    expect(tracker.comments.map((comment) => comment.issue)).toEqual([OPENED]);
    expect(routed).toEqual([
      { origin: ORIGIN, stage: "implement", issue: OPENED, opened: true, note: "the help drifts" },
    ]);
    expect(tracker.comments[0]?.body).toContain(
      `From #10 implement, meant for #7, which ${why}`,
    );
    expect(lines.join("\n")).toContain(`will not comment its Note on #7, which ${why}`);
  });

  it("still comments on a Ticket that is open, unclaimed and not a Spec", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: 7, labels: ["ready-for-agent"], assignees: ["someone"] });

    await routeNotes(routing(tracker), { notes: [{ ticket: 7, note: "the help drifts" }] });

    expect(tracker.comments.map((comment) => comment.issue)).toEqual([7]);
    expect(tracker.createdIssues).toEqual([]);
  });
});

describe("when a Ticket will not take a Note", () => {
  it("sends it to triage rather than losing it", async () => {
    const tracker = new FakeTracker();
    const lines: string[] = [];

    const routed = await routeNotes(routing(tracker, (line) => lines.push(line)), {
      notes: [{ ticket: 404, note: "the flag is wrong" }],
    });

    expect(routed).toEqual([
      {
        origin: ORIGIN,
        stage: "implement",
        issue: OPENED,
        opened: true,
        note: "the flag is wrong",
      },
    ]);
    expect(lines.join("\n")).toContain("could not comment its Note on #404");
  });

  it("tells triage which Ticket the Note was reaching for", async () => {
    const tracker = new FakeTracker();

    await routeNotes(routing(tracker), { notes: [{ ticket: 404, note: "the flag is wrong" }] });

    expect(tracker.comments[0]?.body).toContain(
      "From #10 implement, meant for #404, which would not take the comment",
    );
  });

  it("routes the rest, and says so when triage will not take it either", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: 7 });
    tracker.createIssue = async () => {
      throw new Error("gh: connection reset");
    };
    const lines: string[] = [];

    const routed = await routeNotes(routing(tracker, (line) => lines.push(line)), {
      notes: [{ ticket: 404, note: "lost" }, { ticket: 7, note: "kept" }],
    });

    expect(routed.map((note) => note.note)).toEqual(["kept"]);
    expect(lines.join("\n")).toContain("#10 could not route a Note");
  });

  it("looks again rather than opening a second issue when a create is lost", async () => {
    const tracker = new FakeTracker();
    const createIssue = tracker.createIssue.bind(tracker);
    let lost = true;
    // The issue reaches GitHub and only the answer is lost, which is the one
    // failure that could leave two standing issues open.
    tracker.createIssue = async (issue) => {
      const ref = await createIssue(issue);
      if (!lost) return ref;
      lost = false;
      throw new Error("gh: connection reset");
    };
    const shared = routing(tracker);

    const routed = await routeNotes(shared, { notes: [{ note: "lost" }, { note: "kept" }] });

    expect(tracker.createdIssues).toHaveLength(1);
    expect(routed).toEqual([
      { origin: ORIGIN, stage: "implement", issue: OPENED, opened: false, note: "kept" },
    ]);
  });

  it("tries again for the next Note rather than inheriting the outage", async () => {
    const tracker = new FakeTracker();
    let attempts = 0;
    const createIssue = tracker.createIssue.bind(tracker);
    tracker.createIssue = async (issue) => {
      attempts += 1;
      if (attempts === 1) throw new Error("gh: connection reset");
      return await createIssue(issue);
    };

    const routed = await routeNotes(routing(tracker), {
      notes: [{ note: "lost" }, { note: "kept" }],
    });

    expect(routed.map((note) => note.note)).toEqual(["kept"]);
    expect(tracker.comments.map((comment) => comment.body)).toEqual([
      expect.stringContaining("kept"),
    ]);
  });
});

describe("a Stage with nothing to say", () => {
  it("writes nothing at all, and looks nothing up", async () => {
    const tracker = new FakeTracker();

    expect(await routeNotes(routing(tracker), { notes: [] })).toEqual([]);
    expect(tracker.calls).toEqual([]);
    expect(tracker.comments).toEqual([]);
    expect(tracker.createdIssues).toEqual([]);
  });
});
