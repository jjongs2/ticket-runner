import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type TicketState,
  clearTicketState,
  listTicketStates,
  readTicketState,
  statePath,
  writeTicketState,
} from "./resume.js";

const TICKET = 8;

let repoRoot: string;

function state(overrides: Partial<TicketState> = {}): TicketState {
  return {
    ticket: TICKET,
    branch: "agent/8-rate-limit-release-and-resume",
    state: "implemented",
    fixUsed: false,
    runId: "run-1",
    updatedAt: "2026-09-17T09:00:00.000Z",
    ...overrides,
  };
}

function writeRaw(contents: string): void {
  const path = statePath(repoRoot, TICKET);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "agent-pipeline-resume-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("writeTicketState", () => {
  it("writes one file per Ticket under the pipeline's state directory", () => {
    writeTicketState(repoRoot, state());

    expect(statePath(repoRoot, TICKET)).toBe(
      join(repoRoot, ".agent-pipeline", "state", "ticket-8.json"),
    );
    expect(existsSync(statePath(repoRoot, TICKET))).toBe(true);
  });

  it("leaves the state readable without the pipeline", () => {
    writeTicketState(repoRoot, state({ fixUsed: true, pullRequest: 100 }));

    expect(JSON.parse(readFileSync(statePath(repoRoot, TICKET), "utf8"))).toEqual(
      state({ fixUsed: true, pullRequest: 100 }),
    );
  });

  it("replaces the state a release before it left", () => {
    writeTicketState(repoRoot, state({ state: "claimed" }));
    writeTicketState(repoRoot, state({ state: "implemented", fixUsed: true }));

    expect(readTicketState(repoRoot, TICKET)).toEqual(
      state({ state: "implemented", fixUsed: true }),
    );
  });
});

describe("readTicketState", () => {
  it("reads back what the release recorded", () => {
    writeTicketState(repoRoot, state({ state: "claimed", fixUsed: true }));

    expect(readTicketState(repoRoot, TICKET)).toEqual(state({ state: "claimed", fixUsed: true }));
  });

  it("has nothing to say about a Ticket that was never released", () => {
    expect(readTicketState(repoRoot, TICKET)).toBeUndefined();
  });

  it("ignores a file that is not JSON at all", () => {
    writeRaw("{ not json");

    expect(readTicketState(repoRoot, TICKET)).toBeUndefined();
  });

  it("ignores a file that is missing what resuming needs", () => {
    writeRaw(JSON.stringify({ ticket: TICKET, state: "implemented" }));

    expect(readTicketState(repoRoot, TICKET)).toBeUndefined();
  });

  it("ignores a state recorded for a different Ticket", () => {
    writeRaw(JSON.stringify(state({ ticket: 9 })));

    expect(readTicketState(repoRoot, TICKET)).toBeUndefined();
  });

  it("ignores a state no Run knows how to resume from", () => {
    writeRaw(JSON.stringify({ ...state(), state: "merged" }));

    expect(readTicketState(repoRoot, TICKET)).toBeUndefined();
  });

  it("keeps reading a file a later pipeline added fields to", () => {
    writeRaw(JSON.stringify({ ...state(), somethingNewer: "from a later version" }));

    expect(readTicketState(repoRoot, TICKET)).toEqual(state());
  });
});

describe("clearTicketState", () => {
  it("leaves nothing for a later Run to resume", () => {
    writeTicketState(repoRoot, state());

    clearTicketState(repoRoot, TICKET);

    expect(existsSync(statePath(repoRoot, TICKET))).toBe(false);
    expect(readTicketState(repoRoot, TICKET)).toBeUndefined();
  });

  it("is a no-op on a Ticket that was never released", () => {
    expect(() => clearTicketState(repoRoot, TICKET)).not.toThrow();
  });
});

describe("listTicketStates", () => {
  it("reports every Ticket with state recorded, lowest number first", () => {
    for (const ticket of [12, 3, 8]) writeTicketState(repoRoot, state({ ticket }));

    expect(listTicketStates(repoRoot).map((recorded) => recorded.ticket)).toEqual([3, 8, 12]);
  });

  it("reports what each file says, so a sweep needs no second read", () => {
    writeTicketState(repoRoot, state({ ticket: 3, branch: "agent/3-one", fixUsed: true }));

    expect(listTicketStates(repoRoot)).toEqual([
      state({ ticket: 3, branch: "agent/3-one", fixUsed: true }),
    ]);
  });

  it("has nothing to say on a checkout that has never claimed a Ticket", () => {
    expect(listTicketStates(repoRoot)).toEqual([]);
  });

  it("leaves out a file no Run could resume from, rather than failing the sweep", () => {
    writeTicketState(repoRoot, state({ ticket: 3 }));
    writeRaw("{ not json");

    expect(listTicketStates(repoRoot).map((recorded) => recorded.ticket)).toEqual([3]);
  });

  it("ignores anything in the directory that is not a Ticket's state", () => {
    writeTicketState(repoRoot, state({ ticket: 3 }));
    mkdirSync(join(repoRoot, ".agent-pipeline", "state"), { recursive: true });
    writeFileSync(join(repoRoot, ".agent-pipeline", "state", "notes.txt"), "a human's note");

    expect(listTicketStates(repoRoot).map((recorded) => recorded.ticket)).toEqual([3]);
  });
});
