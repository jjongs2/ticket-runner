import { describe, expect, it } from "vitest";
import { PROGRESS_MARKER, Progress, findProgressComment, progressComment } from "./progress.js";
import type { IssueComment } from "./ports/tracker.js";
import { FakeTracker } from "./testing/fakes.js";

const TICKET = 2;
const BRANCH = "agent/2-progress-comment";

function progress(tracker: FakeTracker, comments: IssueComment[] = []): Progress {
  return new Progress({ tracker, ticket: TICKET, runId: "run-1", branch: BRANCH, comments });
}

function body(tracker: FakeTracker): string {
  return tracker.issue(TICKET).comments.at(-1)?.body ?? "";
}

describe("the comment body", () => {
  it("starts with the marker and names the Run and the branch", () => {
    const rendered = progressComment({ runId: "run-1", branch: BRANCH, rows: [] });

    expect(rendered.split("\n").slice(0, 2)).toEqual([
      PROGRESS_MARKER,
      `**agent-pipeline** · run \`run-1\` · \`${BRANCH}\``,
    ]);
  });

  it("carries the columns Stage, Outcome, Turns and Duration", () => {
    const rendered = progressComment({ runId: "run-1", branch: BRANCH, rows: [] });

    expect(rendered).toContain("| Stage | Outcome | Turns | Duration |");
  });

  it("writes one row per Stage, in the order they finished", () => {
    const rendered = progressComment({
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
      runId: "run-1",
      branch: BRANCH,
      rows: [{ point: "merge", outcome: "✅ #100" }],
    });

    expect(rendered).toContain("| merge | ✅ #100 | – | – |");
  });

  it("escapes a pipe in an outcome so it cannot break the table", () => {
    const rendered = progressComment({
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

  it("rewrites a reused comment with this Run's own header", async () => {
    const tracker = new FakeTracker();
    const issue = tracker.addIssue({ number: TICKET });
    issue.comments.push({ id: "42", body: `${PROGRESS_MARKER}\n**agent-pipeline** · run \`run-0\`` });

    await progress(tracker, issue.comments).record({ point: "implement", outcome: "✅ committed" });

    expect(tracker.updatedComments[0]?.body).toContain("run `run-1`");
    expect(tracker.updatedComments[0]?.body).not.toContain("run `run-0`");
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
      runId: "run-1",
      branch: BRANCH,
      comments: [],
      log: (line) => lines.push(line),
    });

    await expect(recorder.record({ point: "implement", outcome: "✅ committed" })).resolves.toBeUndefined();
    expect(lines).toEqual([`#${TICKET} could not write the progress comment: 502 from GitHub`]);
  });
});
