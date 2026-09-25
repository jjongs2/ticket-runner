import { describe, expect, it } from "vitest";
import { PROGRESS_MARKER, Progress, findProgressComment, progressComment } from "./progress.js";
import type { IssueComment } from "./ports/tracker.js";
import { HANDOFF_MARKER, HANDOFF_TAKEN_LINE } from "./templates.js";
import { FakeTracker } from "./testing/fakes.js";

const TICKET = 2;
const BRANCH = "agent/2-progress-comment";
/** The Version reporting, which every header the Run writes carries. */
const VERSION = "0.4.0+331d79c";

function progress(tracker: FakeTracker, comments: IssueComment[] = []): Progress {
  return new Progress({
    tracker,
    ticket: TICKET,
    version: VERSION,
    runId: "run-1",
    branch: BRANCH,
    comments,
  });
}

function body(tracker: FakeTracker): string {
  return tracker.issue(TICKET).comments.at(-1)?.body ?? "";
}

describe("the comment body", () => {
  it("starts with the marker and names the Version, the Run and the branch", () => {
    const rendered = progressComment({
      version: VERSION,
      runId: "run-1",
      branch: BRANCH,
      rows: [],
    });

    expect(rendered.split("\n").slice(0, 2)).toEqual([
      PROGRESS_MARKER,
      `**agent-pipeline** \`${VERSION}\` · run \`run-1\` · \`${BRANCH}\``,
    ]);
  });

  it("carries the columns Stage, Outcome, Turns and Duration", () => {
    const rendered = progressComment({
      version: VERSION,
      runId: "run-1",
      branch: BRANCH,
      rows: [],
    });

    expect(rendered).toContain("| Stage | Outcome | Turns | Duration |");
  });

  it("writes one row per Stage, in the order they finished", () => {
    const rendered = progressComment({
      version: VERSION,
      runId: "run-1",
      branch: BRANCH,
      rows: [
        { point: "implement", outcome: "✅ committed", turns: 7, durationMs: 1_200_000 },
        { point: "checks", outcome: "✅ passed", durationMs: 120_000 },
      ],
    });

    expect(rendered).toContain("| implement | ✅ committed | 7 | 20m |");
    expect(rendered).toContain("| checks | ✅ passed | – | 2m |");
  });

  it("repeats a Stage that ran twice rather than overwriting its row", () => {
    const rendered = progressComment({
      version: VERSION,
      runId: "run-1",
      branch: BRANCH,
      rows: [
        { point: "checks", outcome: "❌ `npm test` failed", durationMs: 0 },
        { point: "fix", outcome: "✅ committed", turns: 4, durationMs: 0 },
        { point: "checks", outcome: "✅ passed", durationMs: 0 },
      ],
    });

    expect(rendered.match(/^\| checks \|/gm)).toHaveLength(2);
  });

  it("dashes the cells a row has no answer for", () => {
    const rendered = progressComment({
      version: VERSION,
      runId: "run-1",
      branch: BRANCH,
      rows: [{ point: "merge", outcome: "✅ #100" }],
    });

    expect(rendered).toContain("| merge | ✅ #100 | – | – |");
  });

  it("escapes a pipe in an outcome so it cannot break the table", () => {
    const rendered = progressComment({
      version: VERSION,
      runId: "run-1",
      branch: BRANCH,
      rows: [{ point: "checks", outcome: "❌ `npm test | tee log` failed", durationMs: 0 }],
    });

    expect(rendered).toContain("| checks | ❌ `npm test \\| tee log` failed | – | 0m |");
  });
});

describe("finding the comment again", () => {
  it("finds the one carrying the marker", () => {
    const found = findProgressComment([
      { id: "1", body: "a human said something" },
      { id: "2", body: `${PROGRESS_MARKER}\n**agent-pipeline** · run \`run-0\`` },
    ]);

    expect(found?.id).toBe("2");
  });

  it("ignores a comment that only mentions the marker further down", () => {
    const found = findProgressComment([
      { id: "1", body: `the pipeline writes ${PROGRESS_MARKER} as its first line` },
    ]);

    expect(found).toBeUndefined();
  });

  it("finds nothing on a Ticket no Stage has reported on", () => {
    expect(findProgressComment([])).toBeUndefined();
  });

  it("finds the newest of several, which is the one this Run posted", () => {
    const found = findProgressComment([
      { id: "1", body: `${PROGRESS_MARKER}\nwhat a human read before the hand-off` },
      { id: "2", body: `${PROGRESS_MARKER}\nwhat the Run that took it back posted` },
    ]);

    expect(found?.id).toBe("2");
  });
});

describe("recording a Stage", () => {
  it("creates the comment on the first Stage of a Ticket", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: TICKET });

    await progress(tracker).record({ point: "implement", outcome: "✅ committed", turns: 7 });

    expect(tracker.comments).toHaveLength(1);
    expect(body(tracker)).toContain("| implement | ✅ committed | 7 | – |");
  });

  it("edits that same comment on every later Stage", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: TICKET });
    const recorder = progress(tracker);

    await recorder.record({ point: "implement", outcome: "✅ committed", turns: 7 });
    await recorder.record({ point: "checks", outcome: "✅ passed", durationMs: 0 });

    expect(tracker.comments).toHaveLength(1);
    expect(tracker.updatedComments).toHaveLength(1);
    expect(body(tracker)).toContain("| implement | ✅ committed | 7 | – |");
    expect(body(tracker)).toContain("| checks | ✅ passed | – | 0m |");
  });

  it("reuses the comment an earlier Run left behind", async () => {
    const tracker = new FakeTracker();
    const issue = tracker.addIssue({ number: TICKET });
    issue.comments.push({ id: "42", body: `${PROGRESS_MARKER}\nold` });

    await progress(tracker, issue.comments).record({ point: "implement", outcome: "✅ committed" });

    expect(tracker.comments).toEqual([]);
    expect(tracker.updatedComments).toEqual([
      { id: "42", body: expect.stringContaining("| implement | ✅ committed | – | – |") },
    ]);
  });

  it("keeps an earlier Run's header and rows and writes its own below them", async () => {
    const tracker = new FakeTracker();
    const issue = tracker.addIssue({ number: TICKET });
    const earlier = progressComment({
      version: "0.5.0",
      runId: "run-0",
      branch: BRANCH,
      rows: [{ point: "implement", outcome: "✅ committed", turns: 46, durationMs: 1_260_000 }],
    });
    issue.comments.push({ id: "42", body: earlier });

    await progress(tracker, issue.comments).record({ point: "checks", outcome: "✅ passed" });

    expect(tracker.updatedComments[0]?.body).toBe(
      [
        earlier,
        `**agent-pipeline** \`${VERSION}\` · run \`run-1\` · \`${BRANCH}\``,
        "",
        "| Stage | Outcome | Turns | Duration |",
        "|---|---|---|---|",
        "| checks | ✅ passed | – | – |",
        "",
      ].join("\n"),
    );
  });

  it("shows three Runs as three sections, oldest first", async () => {
    const tracker = new FakeTracker();
    const issue = tracker.addIssue({ number: TICKET });
    const runOf = (runId: string, comments: IssueComment[]) =>
      new Progress({ tracker, ticket: TICKET, version: VERSION, runId, branch: BRANCH, comments });

    await runOf("run-1", []).record({ point: "implement", outcome: "⏸ rate limited" });
    await runOf("run-2", issue.comments).record({ point: "implement", outcome: "✅ committed" });
    await runOf("run-3", issue.comments).record({ point: "checks", outcome: "✅ passed" });

    expect(tracker.comments).toHaveLength(1);
    expect([...body(tracker).matchAll(/run `(run-\d)`/g)].map((match) => match[1])).toEqual([
      "run-1",
      "run-2",
      "run-3",
    ]);
    expect(body(tracker).match(/^\| Stage \|/gm)).toHaveLength(3);
  });

  it("rewrites its own section when it is already the last one, rather than adding another", async () => {
    const tracker = new FakeTracker();
    const issue = tracker.addIssue({ number: TICKET });
    const earlier = progressComment({
      version: "0.5.0",
      runId: "run-0",
      branch: BRANCH,
      rows: [{ point: "implement", outcome: "⏸ rate limited" }],
    });
    issue.comments.push({ id: "42", body: earlier });

    await progress(tracker, issue.comments).record({ point: "implement", outcome: "✅ committed" });
    // This Run reads the Ticket again, as it does on a second pass of it.
    const again = progress(tracker, issue.comments);
    await again.record({ point: "checks", outcome: "✅ passed" });
    await again.record({ point: "verify", outcome: "❌ 1 unmet" });

    expect(tracker.comments).toEqual([]);
    expect(body(tracker).match(/run `run-1`/g)).toHaveLength(1);
    expect(body(tracker).startsWith(earlier)).toBe(true);
    expect(body(tracker)).toContain("| checks | ✅ passed | – | – |\n| verify | ❌ 1 unmet | – | – |");
  });

  it("keeps a comment an earlier Version wrote as the first section, byte for byte", async () => {
    const tracker = new FakeTracker();
    const issue = tracker.addIssue({ number: TICKET });
    const single = [
      PROGRESS_MARKER,
      `**agent-pipeline** \`0.4.0+331d79c\` · run \`run-0\` · \`${BRANCH}\``,
      "",
      "| Stage | Outcome | Turns | Duration |",
      "|---|---|---|---|",
      "| implement | ✅ committed | 7 | 20m |",
      "| checks | ✅ passed | – | 2m |",
      "",
    ].join("\n");
    issue.comments.push({ id: "42", body: single });

    await progress(tracker, issue.comments).record({ point: "verify", outcome: "❌ no Verdict" });

    expect(body(tracker).startsWith(`${single}\n**agent-pipeline** \`${VERSION}\` · run \`run-1\``)).toBe(
      true,
    );
  });

  it("names no Host in the header it writes", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: TICKET });

    await progress(tracker).record({ point: "implement", outcome: "✅ committed" });

    const header = body(tracker).split("\n")[1];
    expect(header).toBe(`**agent-pipeline** \`${VERSION}\` · run \`run-1\` · \`${BRANCH}\``);
  });

  it("starts a fresh comment when the Ticket is being taken back from a human", async () => {
    const tracker = new FakeTracker();
    const issue = tracker.addIssue({ number: TICKET });
    issue.comments.push({ id: "42", body: `${PROGRESS_MARKER}\nwhat the human read` });
    issue.comments.push({ id: "43", body: HANDOFF_MARKER + "\n**Handed off.**" });

    await progress(tracker, issue.comments).record({ point: "checks", outcome: "✅ passed" });

    // The table the human was handed stays as they read it; this Run reports
    // beside it rather than over it.
    expect(tracker.updatedComments).toEqual([]);
    expect(tracker.comments).toHaveLength(1);
  });

  it("carries on in the comment when the hand-off it finds is already history", async () => {
    const tracker = new FakeTracker();
    const issue = tracker.addIssue({ number: TICKET });
    issue.comments.push({ id: "42", body: `${PROGRESS_MARKER}\nwhat an earlier Run wrote` });
    issue.comments.push({
      id: "43",
      body: `${HANDOFF_MARKER}\n${HANDOFF_TAKEN_LINE}\n\n**Handed off.**`,
    });

    await progress(tracker, issue.comments).record({ point: "checks", outcome: "✅ passed" });

    // A hand-off a Run already took back is not a human holding the Ticket: this
    // is the same Run's second reading of the Ticket, or a later resume of it.
    expect(tracker.comments).toEqual([]);
    expect(tracker.updatedComments.map(({ id }) => id)).toEqual(["42"]);
  });

  it("starts a fresh comment when the one already there cannot be edited", async () => {
    const tracker = new FakeTracker();
    const issue = tracker.addIssue({ number: TICKET });
    issue.comments.push({ body: `${PROGRESS_MARKER}\nposted by something with no id` });

    await progress(tracker, issue.comments).record({ point: "implement", outcome: "✅ committed" });

    expect(tracker.comments).toHaveLength(1);
    expect(tracker.updatedComments).toEqual([]);
  });

  it("stops after a comment it cannot edit, rather than posting one per Stage", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: TICKET });
    const lines: string[] = [];
    let posted = 0;
    tracker.comment = async (_number, body) => {
      posted += 1;
      return { body };
    };
    const recorder = new Progress({
      tracker,
      ticket: TICKET,
      version: VERSION,
      runId: "run-1",
      branch: BRANCH,
      comments: [],
      log: (line) => lines.push(line),
    });

    await recorder.record({ point: "implement", outcome: "✅ committed" });
    await recorder.record({ point: "checks", outcome: "✅ passed" });

    expect(posted).toBe(1);
    expect(lines).toEqual([`#${TICKET} posted a progress comment it cannot edit again`]);
  });

  it("swallows a tracker that will not take the comment, because a Ticket is not lost over one", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: TICKET });
    const lines: string[] = [];
    tracker.comment = () => Promise.reject(new Error("502 from GitHub"));
    const recorder = new Progress({
      tracker,
      ticket: TICKET,
      version: VERSION,
      runId: "run-1",
      branch: BRANCH,
      comments: [],
      log: (line) => lines.push(line),
    });

    await expect(recorder.record({ point: "implement", outcome: "✅ committed" })).resolves.toBeUndefined();
    expect(lines).toEqual([`#${TICKET} could not write the progress comment: 502 from GitHub`]);
  });
});
