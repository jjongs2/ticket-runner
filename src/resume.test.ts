import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TicketState } from "./ports/workspace.js";
import {
  LOCAL_STATE_DIR,
  localStateTickets,
  readStateFile,
  stateFileContents,
  stateFileName,
  stateFileTicket,
} from "./resume.js";

const TICKET = 8;

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

/** What a file of this Ticket's that holds `contents` reads as. */
function read(contents: string) {
  return readStateFile(contents, TICKET);
}

describe("the State file's name", () => {
  it("is one per Ticket, and names the Ticket back", () => {
    expect(stateFileName(TICKET)).toBe("ticket-8.json");
    expect(stateFileTicket(stateFileName(TICKET))).toBe(TICKET);
  });

  it("names no Ticket for anything else a directory holds", () => {
    expect(stateFileTicket("notes.txt")).toBeUndefined();
    expect(stateFileTicket("ticket-8")).toBeUndefined();
    expect(stateFileTicket("ticket-8.json.bak")).toBeUndefined();
  });
});

describe("what a State file says", () => {
  it("reads back what was written, readable without the pipeline", () => {
    const contents = stateFileContents(state({ fixUsed: true, pullRequest: 100 }));

    expect(JSON.parse(contents)).toEqual(state({ fixUsed: true, pullRequest: 100 }));
    expect(read(contents)).toEqual({
      readable: true,
      state: state({ fixUsed: true, pullRequest: 100 }),
    });
  });

  it("carries the Version that wrote the file", () => {
    expect(read(stateFileContents(state({ version: "0.4.0+331d79c" })))).toEqual({
      readable: true,
      state: state({ version: "0.4.0+331d79c" }),
    });
  });

  it("still resumes a file written before a Version was recorded in one", () => {
    // Every field but the Version, which is what a file from before this
    // existed looks like. It has to resume, not be started over.
    const file = read(JSON.stringify(state()));

    expect(file).toEqual({ readable: true, state: state() });
    expect(file.readable && file.state).not.toHaveProperty("version");
  });

  it("keeps reading a file a later pipeline added fields to", () => {
    expect(read(JSON.stringify({ ...state(), somethingNewer: "from a later version" }))).toEqual(
      { readable: true, state: state() },
    );
  });

  it("cannot be used when it is not JSON at all, and names no Version", () => {
    expect(read("{ not json")).toEqual({ readable: false, ticket: TICKET });
  });

  it("cannot be used when it is missing what resuming needs", () => {
    expect(read(JSON.stringify({ ticket: TICKET, state: "implemented" }))).toEqual({
      readable: false,
      ticket: TICKET,
    });
  });

  it("cannot be used when it records a state no Run knows how to resume from", () => {
    expect(read(JSON.stringify({ ...state(), state: "merged" })).readable).toBe(false);
  });

  it("names the Version a file it cannot read says wrote it", () => {
    expect(read(JSON.stringify({ version: "9.9.0", somethingNewer: "later" }))).toEqual({
      readable: false,
      ticket: TICKET,
      version: "9.9.0",
    });
  });

  it("names no Version where the file holds something that is not one", () => {
    expect(read(JSON.stringify({ version: 4, state: "merged" }))).toEqual({
      readable: false,
      ticket: TICKET,
    });
  });

  it("cannot be used when its Ticket disagrees with its name", () => {
    expect(read(JSON.stringify(state({ ticket: TICKET + 1, version: "0.4.0" })))).toEqual({
      readable: false,
      ticket: TICKET,
      version: "0.4.0",
    });
  });
});

describe("the State files an earlier pipeline left in the checkout", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "agent-pipeline-resume-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function leave(name: string): void {
    mkdirSync(join(repoRoot, LOCAL_STATE_DIR), { recursive: true });
    writeFileSync(join(repoRoot, LOCAL_STATE_DIR, name), "{}");
  }

  it("are named by Ticket, lowest number first", () => {
    for (const ticket of [12, 3, 8]) leave(stateFileName(ticket));

    expect(localStateTickets(repoRoot)).toEqual([3, 8, 12]);
  });

  it("are none on a checkout no earlier pipeline claimed anything on", () => {
    expect(localStateTickets(repoRoot)).toEqual([]);
  });

  it("leave out anything in the directory that is not a Ticket's state", () => {
    leave(stateFileName(3));
    leave("notes.txt");

    expect(localStateTickets(repoRoot)).toEqual([3]);
  });
});
