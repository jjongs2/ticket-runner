import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TicketState, statePath, writeTicketState } from "./resume.js";
import { holdsClaim, strandedTickets } from "./stranded.js";
import { FakeTracker } from "./testing/fakes.js";

const IN_PROGRESS = "in-progress";

let tracker: FakeTracker;
let logged: string[];
/** A temporary repo root, because the State files a sweep reads are real files. */
let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "agent-pipeline-stranded-"));
  tracker = new FakeTracker();
  logged = [];
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function sweep() {
  return strandedTickets({
    tracker,
    repoRoot,
    inProgress: IN_PROGRESS,
    log: (line) => logged.push(line),
  });
}

/** Record state for a Ticket, as the Claim and every Stage after it does. */
function recorded(ticket: number, overrides: Partial<TicketState> = {}): void {
  writeTicketState(repoRoot, {
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

    expect(existsSync(statePath(repoRoot, 4))).toBe(true);
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
    expect(existsSync(statePath(repoRoot, 4))).toBe(true);
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
    expect(existsSync(statePath(repoRoot, 4))).toBe(true);
    expect(logged).toEqual(["#4 is resumable, but octocat holds it now"]);
  });

  it("leaves a Ticket the tracker could not be asked about alone", async () => {
    claimed(4);
    tracker.getIssue = async () => {
      throw new Error("gh: connection reset");
    };

    expect(await sweep()).toEqual([]);
    expect(existsSync(statePath(repoRoot, 4))).toBe(true);
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
    expect(existsSync(statePath(repoRoot, 4))).toBe(false);
    expect(logged).toEqual(["#4 has closed, so the state it left is gone"]);
  });

  it("is forgotten even when the Claim is somebody else's, since nothing is left to resume", async () => {
    tracker.addIssue({ number: 4, closed: true, assignees: ["octocat"], labels: [IN_PROGRESS] });
    recorded(4);

    expect(await sweep()).toEqual([]);
    expect(existsSync(statePath(repoRoot, 4))).toBe(false);
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
