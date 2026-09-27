import { describe, expect, it } from "vitest";
import { carriesCurrentHandoff, markHandoffsTaken } from "./handoff.js";
import type { IssueComment } from "./ports/tracker.js";
import { PROGRESS_MARKER } from "./progress.js";
import { HANDOFF_TAKEN_LINE, handoffComment, handoffTakenComment } from "./templates.js";
import { FakeTracker } from "./testing/fakes.js";

const TICKET = 2;

const HANDOFF = handoffComment({
  stage: "verify",
  failure: "1 criterion unmet",
  branch: "agent/2-skeleton",
  worktree: "/repo/.worktrees/ticket-2",
  evidence: "docs updated — nothing written",
});

/** A Ticket carrying `comments`, with the ids the tracker would have given them. */
function ticket(...bodies: string[]): { tracker: FakeTracker; comments: IssueComment[] } {
  const tracker = new FakeTracker();
  tracker.addIssue({ number: TICKET });
  const comments = bodies.map((body, index) => {
    const comment: IssueComment = { id: `c${index + 1}`, body };
    tracker.issue(TICKET).comments.push(comment);
    return comment;
  });
  return { tracker, comments };
}

function bodies(tracker: FakeTracker): string[] {
  return tracker.issue(TICKET).comments.map((comment) => comment.body);
}

describe("marking a hand-off as history", () => {
  it("adds the line under the marker and leaves everything else as it was", async () => {
    const { tracker, comments } = ticket(HANDOFF);

    await markHandoffsTaken({ tracker, ticket: TICKET, comments });

    const [marked = ""] = bodies(tracker);
    expect(marked.split("\n").slice(0, 2)).toEqual([
      "<!-- ticket-runner:handoff -->",
      HANDOFF_TAKEN_LINE,
    ]);
    expect(marked).toContain("**Handed off.** Failed at **verify**.");
    expect(marked).toContain("- Failure: 1 criterion unmet");
    expect(marked).toContain("Branch `agent/2-skeleton`");
    expect(marked).toContain("worktree `/repo/.worktrees/ticket-2`");
    expect(marked).toContain("docs updated — nothing written");
  });

  it("edits in place rather than posting anything new", async () => {
    const { tracker, comments } = ticket(HANDOFF);

    await markHandoffsTaken({ tracker, ticket: TICKET, comments });

    expect(tracker.calls).toEqual(["updateComment:c1"]);
    expect(tracker.comments).toEqual([]);
  });

  it("marks every hand-off on the Ticket, not only the newest", async () => {
    const { tracker, comments } = ticket(HANDOFF, PROGRESS_MARKER, HANDOFF);

    await markHandoffsTaken({ tracker, ticket: TICKET, comments });

    expect(tracker.calls).toEqual(["updateComment:c1", "updateComment:c3"]);
    expect(bodies(tracker).map((body) => body.includes(HANDOFF_TAKEN_LINE))).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("leaves a comment that is already marked alone, so the line never stacks", async () => {
    const { tracker, comments } = ticket(HANDOFF);
    await markHandoffsTaken({ tracker, ticket: TICKET, comments });
    const once = bodies(tracker);

    await markHandoffsTaken({
      tracker,
      ticket: TICKET,
      comments: tracker.issue(TICKET).comments,
    });

    expect(bodies(tracker)).toEqual(once);
    expect(tracker.calls).toEqual(["updateComment:c1"]);
  });

  it("touches no comment the marker is not the first line of", async () => {
    const { tracker, comments } = ticket(PROGRESS_MARKER, `a human quoting ${HANDOFF}`);

    await markHandoffsTaken({ tracker, ticket: TICKET, comments });

    expect(tracker.calls).toEqual([]);
  });

  it("skips a hand-off the tracker gave no id for and carries on to the next", async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ number: TICKET });
    const comments: IssueComment[] = [{ body: HANDOFF }, { id: "c9", body: HANDOFF }];
    tracker.issue(TICKET).comments.push(...comments);

    await markHandoffsTaken({ tracker, ticket: TICKET, comments });

    expect(tracker.calls).toEqual(["updateComment:c9"]);
  });

  it("logs a refused edit and still marks the hand-offs after it", async () => {
    const { tracker, comments } = ticket(HANDOFF, HANDOFF);
    const logged: string[] = [];
    const update = tracker.updateComment.bind(tracker);
    tracker.updateComment = async (id, body) => {
      if (id === "c1") throw new Error("comment is locked");
      await update(id, body);
    };

    await markHandoffsTaken({
      tracker,
      ticket: TICKET,
      comments,
      log: (line) => logged.push(line),
    });

    expect(logged).toEqual([
      `#${TICKET} could not mark a hand-off comment as history: comment is locked`,
    ]);
    expect(bodies(tracker)[1]).toContain(HANDOFF_TAKEN_LINE);
  });

  it("writes nothing to a Ticket that has no hand-off comment", async () => {
    const { tracker, comments } = ticket(PROGRESS_MARKER);

    await markHandoffsTaken({ tracker, ticket: TICKET, comments });

    expect(tracker.calls).toEqual([]);
  });
});

describe("a hand-off the Ticket is still carrying", () => {
  it("is what a Ticket a human is holding looks like", () => {
    expect(carriesCurrentHandoff([{ id: "c1", body: HANDOFF }])).toBe(true);
  });

  it("is not one a later Run has already marked as history", () => {
    const taken = handoffTakenComment(HANDOFF) as string;

    expect(carriesCurrentHandoff([{ id: "c1", body: taken }])).toBe(false);
  });

  it("is still current when only one of several has been marked", () => {
    const taken = handoffTakenComment(HANDOFF) as string;

    expect(carriesCurrentHandoff([{ id: "c1", body: taken }, { id: "c2", body: HANDOFF }])).toBe(
      true,
    );
  });

  it("is nothing on a Ticket that was never handed off", () => {
    expect(carriesCurrentHandoff([{ id: "c1", body: `${PROGRESS_MARKER}\na table` }])).toBe(false);
  });
});
