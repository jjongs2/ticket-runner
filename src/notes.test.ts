import { describe, expect, it } from "vitest";
import { NOTES_JSON_SCHEMA, parseNotes, routeNotes } from "./notes.js";
import { FakeTracker } from "./testing/fakes.js";

const ORIGIN = 10;

function routing(tracker: FakeTracker, log?: (line: string) => void) {
  return {
    tracker,
    origin: ORIGIN,
    stage: "implement" as const,
    needsTriage: "needs-triage",
    ...(log === undefined ? {} : { log }),
  };
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
  it("opens an issue rather than commenting on a Ticket that is closing", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: ORIGIN });

    const routed = await routeNotes(routing(tracker), {
      notes: [{ ticket: ORIGIN, note: "the flag needs renaming" }],
    });

    expect(tracker.comments).toEqual([]);
    expect(tracker.createdIssues).toHaveLength(1);
    expect(routed).toEqual([
      {
        origin: ORIGIN,
        stage: "implement",
        issue: 200,
        opened: true,
        note: "the flag needs renaming",
      },
    ]);
  });
});

describe("routing a Note that names no Ticket", () => {
  it("opens a needs-triage issue naming the origin Ticket and Stage", async () => {
    const tracker = new FakeTracker();

    await routeNotes(routing(tracker), {
      notes: [{ note: "Nothing cleans up abandoned worktrees. A Run leaks one per hand-off." }],
    });

    expect(tracker.createdIssues).toEqual([
      {
        title: "Nothing cleans up abandoned worktrees",
        body:
          "From #10 implement\n\n" +
          "Nothing cleans up abandoned worktrees. A Run leaks one per hand-off.\n",
        labels: ["needs-triage"],
      },
    ]);
  });

  it("reports the issue it opened", async () => {
    const tracker = new FakeTracker();

    const routed = await routeNotes(routing(tracker), { notes: [{ note: "no cleanup" }] });

    expect(routed).toEqual([
      { origin: ORIGIN, stage: "implement", issue: 200, opened: true, note: "no cleanup" },
    ]);
  });

  it("titles the issue with the note itself when it is one short sentence", async () => {
    const tracker = new FakeTracker();

    await routeNotes(routing(tracker), { notes: [{ note: "no cleanup" }] });

    expect(tracker.createdIssues[0]?.title).toBe("no cleanup");
  });

  it("trims a long first sentence to fit an issue list", async () => {
    const tracker = new FakeTracker();
    const note = `The worktree ${"very ".repeat(30)}long`;

    await routeNotes(routing(tracker), { notes: [{ note }] });

    const title = tracker.createdIssues[0]?.title as string;
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title.endsWith("…")).toBe(true);
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

  it("escapes a checkbox in a Note it opens an issue for", async () => {
    const tracker = new FakeTracker();

    await routeNotes(routing(tracker), { notes: [{ note: "todo\n* [ ] one" }] });

    expect(tracker.createdIssues[0]?.body).toContain("* \\[ \\] one");
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

describe("when a Ticket will not take a Note", () => {
  it("opens an issue for it rather than losing it", async () => {
    const tracker = new FakeTracker();
    const lines: string[] = [];

    const routed = await routeNotes(routing(tracker, (line) => lines.push(line)), {
      notes: [{ ticket: 404, note: "the flag is wrong" }],
    });

    expect(routed).toEqual([
      {
        origin: ORIGIN,
        stage: "implement",
        issue: 200,
        opened: true,
        note: "the flag is wrong",
      },
    ]);
    expect(lines.join("\n")).toContain("could not comment its Note on #404");
  });

  it("tells triage which Ticket the Note was reaching for", async () => {
    const tracker = new FakeTracker();

    await routeNotes(routing(tracker), { notes: [{ ticket: 404, note: "the flag is wrong" }] });

    expect(tracker.createdIssues[0]?.body).toContain(
      "From #10 implement, meant for #404, which would not take the comment",
    );
  });

  it("routes the rest, and says so when the queue will not take it either", async () => {
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
});

describe("a Stage with nothing to say", () => {
  it("writes nothing at all", async () => {
    const tracker = new FakeTracker();

    expect(await routeNotes(routing(tracker), { notes: [] })).toEqual([]);
    expect(tracker.calls).toEqual([]);
    expect(tracker.comments).toEqual([]);
    expect(tracker.createdIssues).toEqual([]);
  });
});
