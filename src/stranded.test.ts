import { beforeEach, describe, expect, it } from "vitest";
import type { TicketState } from "./ports/workspace.js";
import { holdsClaim, strandedTickets } from "./stranded.js";
import { FakeTracker, FakeWorkspace } from "./testing/fakes.js";

const IN_PROGRESS = "in-progress";

let tracker: FakeTracker;
let logged: string[];
/** Where the State the sweep reads is kept. */
let workspace: FakeWorkspace;

beforeEach(() => {
  tracker = new FakeTracker();
  workspace = new FakeWorkspace();
  logged = [];
});

function sweep() {
  return strandedTickets({
    tracker,
    workspace,
    inProgress: IN_PROGRESS,
    log: (line) => logged.push(line),
  });
}

/** Record state for a Ticket, as the Claim and every Stage after it does. */
function recorded(ticket: number, overrides: Partial<TicketState> = {}): void {
  workspace.recordState({
    ticket,
    branch: `agent/${ticket}-a-ticket`,
    state: "implemented",
    fixUsed: false,
    runId: "run-0",
    updatedAt: "2026-09-17T09:00:00.000Z",
    ...overrides,
  });
}

/** A Ticket wearing the Claim a Run that never came back left on it. */
function claimed(ticket: number): void {
  tracker.addIssue({ number: ticket, assignees: [tracker.user], labels: [IN_PROGRESS] });
  recorded(ticket);
}

describe("a Ticket a Run left claimed", () => {
  it("is stranded, and named with the branch its state records", async () => {
    claimed(4);

    expect(await sweep()).toEqual([{ number: 4, title: "Ticket 4", branch: "agent/4-a-ticket" }]);
  });

  it("is reported in ascending number, as a Run takes them", async () => {
    for (const ticket of [9, 4, 6]) claimed(ticket);

    expect((await sweep()).map((ticket) => ticket.number)).toEqual([4, 6, 9]);
  });

  it("keeps its state file: the Run is about to resume from it", async () => {
    claimed(4);

    await sweep();

    expect(workspace.states.has(4)).toBe(true);
  });

  it("is stranded whatever the branch its title would derive to now", async () => {
    tracker.addIssue({
      number: 4,
      title: "A title somebody rewrote",
      assignees: [tracker.user],
      labels: [IN_PROGRESS],
    });
    recorded(4, { branch: "agent/4-what-it-was-called-then" });

    expect(await sweep()).toEqual([
      { number: 4, title: "A title somebody rewrote", branch: "agent/4-what-it-was-called-then" },
    ]);
  });
});

describe("what the sweep leaves alone", () => {
  it("passes over a Ticket whose Claim has come off, which is a released one", async () => {
    tracker.addIssue({ number: 4, labels: ["ready-for-agent"] });
    recorded(4);

    expect(await sweep()).toEqual([]);
    // The Frontier picks that one up on its own terms, so the state stays.
    expect(workspace.states.has(4)).toBe(true);
  });

  it("passes over a handed-off Ticket in silence, leaving its file and Claim", async () => {
    tracker.addIssue({ number: 4, labels: ["ready-for-human"] });
    recorded(4);

    expect(await sweep()).toEqual([]);
    // Inert: no Frontier can offer it and nothing here touches it, so it waits
    // exactly as it is until a human relabels it or the issue closes.
    expect(workspace.states.has(4)).toBe(true);
    expect(tracker.issue(4).labels).toEqual(["ready-for-human"]);
    expect(tracker.issue(4).assignees).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("passes over a Ticket assigned to nobody but still labelled in-progress", async () => {
    tracker.addIssue({ number: 4, labels: [IN_PROGRESS] });
    recorded(4);

    expect(await sweep()).toEqual([]);
  });

  it("leaves a Ticket somebody else now holds where it is, and says so", async () => {
    tracker.addIssue({ number: 4, assignees: ["octocat"], labels: [IN_PROGRESS] });
    recorded(4);

    expect(await sweep()).toEqual([]);
    expect(workspace.states.has(4)).toBe(true);
    expect(logged).toEqual(["#4 is resumable, but octocat holds it now"]);
  });

  it("leaves a Ticket the tracker could not be asked about alone", async () => {
    claimed(4);
    tracker.getIssue = async () => {
      throw new Error("gh: connection reset");
    };

    expect(await sweep()).toEqual([]);
    expect(workspace.states.has(4)).toBe(true);
    expect(logged).toEqual(["#4 is resumable, but reading it failed: gh: connection reset"]);
  });

  it("carries on down the rest of the sweep when one Ticket cannot be read", async () => {
    claimed(4);
    claimed(6);
    const getIssue = tracker.getIssue.bind(tracker);
    tracker.getIssue = async (number) => {
      if (number === 4) throw new Error("gh: connection reset");
      return getIssue(number);
    };

    expect((await sweep()).map((ticket) => ticket.number)).toEqual([6]);
  });
});

describe("a Ticket that has closed", () => {
  it("has its state removed rather than resumed", async () => {
    tracker.addIssue({ number: 4, closed: true, assignees: [tracker.user], labels: [IN_PROGRESS] });
    recorded(4);

    expect(await sweep()).toEqual([]);
    expect(workspace.states.has(4)).toBe(false);
    expect(logged).toEqual(["#4 has closed, so the state it left is gone"]);
  });

  it("is forgotten even when the Claim is somebody else's, since nothing is left to resume", async () => {
    tracker.addIssue({ number: 4, closed: true, assignees: ["octocat"], labels: [IN_PROGRESS] });
    recorded(4);

    expect(await sweep()).toEqual([]);
    expect(workspace.states.has(4)).toBe(false);
  });
});

describe("a State file the sweep cannot read", () => {
  /** What an older or newer pipeline left behind, as far as this one can read it. */
  function unreadable(ticket: number, version?: string): void {
    workspace.states.set(ticket, {
      readable: false,
      ticket,
      ...(version === undefined ? {} : { version }),
    });
  }

  it("is reported by Ticket number and the Version the file names", async () => {
    tracker.addIssue({ number: 4, assignees: [tracker.user], labels: [IN_PROGRESS] });
    unreadable(4, "9.9.0");

    expect(await sweep()).toEqual([]);
    expect(logged).toEqual([
      "#4 has a State file this Version cannot use, written by 9.9.0; it and the Claim are left alone",
    ]);
  });

  it("says so when the file names no Version at all", async () => {
    unreadable(4);

    expect(logged).toEqual([]);
    expect(await sweep()).toEqual([]);
    expect(logged).toEqual([
      "#4 has a State file this Version cannot use, naming no Version; it and the Claim are left alone",
    ]);
  });

  it("leaves the file where it is, and the Claim on the board with it", async () => {
    tracker.addIssue({ number: 4, assignees: [tracker.user], labels: [IN_PROGRESS] });
    unreadable(4);

    await sweep();

    expect(workspace.states.has(4)).toBe(true);
    const issue = await tracker.getIssue(4);
    expect(issue.assignees).toEqual([tracker.user]);
    expect(issue.labels).toEqual([IN_PROGRESS]);
  });

  it("is reported without asking the tracker anything at all", async () => {
    unreadable(4);
    let asked = 0;
    tracker.currentUser = async () => {
      asked += 1;
      return "pipeline-user";
    };

    expect(await sweep()).toEqual([]);
    expect(asked).toBe(0);
    expect(logged).toHaveLength(1);
  });

  it("does not stop the Tickets beside it being swept", async () => {
    claimed(6);
    unreadable(4);

    expect((await sweep()).map((ticket) => ticket.number)).toEqual([6]);
  });
});

describe("a checkout with nothing recorded", () => {
  it("sweeps nothing, and does not even ask who the user is", async () => {
    tracker.addIssue({ number: 4, assignees: [tracker.user], labels: [IN_PROGRESS] });
    let asked = 0;
    tracker.currentUser = async () => {
      asked += 1;
      return "pipeline-user";
    };

    expect(await sweep()).toEqual([]);
    expect(asked).toBe(0);
  });
});

describe("holdsClaim", () => {
  const issue = (assignees: string[], labels: string[]) =>
    tracker.addIssue({ number: 4, assignees, labels });

  it("reads the Claim as both halves of it together", () => {
    expect(holdsClaim(issue([tracker.user], [IN_PROGRESS]), tracker.user, IN_PROGRESS)).toBe(true);
  });

  it("is not held by the label alone", () => {
    expect(holdsClaim(issue([], [IN_PROGRESS]), tracker.user, IN_PROGRESS)).toBe(false);
  });

  it("is not held by the assignee alone", () => {
    expect(holdsClaim(issue([tracker.user], []), tracker.user, IN_PROGRESS)).toBe(false);
  });

  it("is not held when somebody else is the assignee", () => {
    expect(holdsClaim(issue(["octocat"], [IN_PROGRESS]), tracker.user, IN_PROGRESS)).toBe(false);
  });
});
