import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type StateFile,
  type TicketState,
  clearTicketState,
  listStateFiles,
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

  it("carries the Version that wrote the file", () => {
    writeTicketState(repoRoot, state({ version: "0.4.0+331d79c" }));

    expect(readTicketState(repoRoot, TICKET)).toEqual(state({ version: "0.4.0+331d79c" }));
  });

  it("still resumes a file written before a Version was recorded in one", () => {
    // Every field but the Version, which is what a file from before this
    // existed looks like. It has to resume, not be started over.
    writeRaw(JSON.stringify(state()));

    expect(readTicketState(repoRoot, TICKET)).toEqual(state());
    expect(readTicketState(repoRoot, TICKET)).not.toHaveProperty("version");
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

describe("listStateFiles", () => {
  /** What each file in the list turned out to be, lowest Ticket number first. */
  function listed(): StateFile[] {
    return listStateFiles(repoRoot);
  }

  it("reports every Ticket with state recorded, lowest number first", () => {
    for (const ticket of [12, 3, 8]) writeTicketState(repoRoot, state({ ticket }));

    expect(listed().map(readableState).map((recorded) => recorded?.ticket)).toEqual([3, 8, 12]);
  });

  it("reports what each file says, so a sweep needs no second read", () => {
    writeTicketState(repoRoot, state({ ticket: 3, branch: "agent/3-one", fixUsed: true }));

    expect(listed()).toEqual([
      { readable: true, state: state({ ticket: 3, branch: "agent/3-one", fixUsed: true }) },
    ]);
  });

  it("has nothing to say on a checkout that has never claimed a Ticket", () => {
    expect(listed()).toEqual([]);
  });

  it("reports a file no Run could resume from rather than dropping it", () => {
    writeTicketState(repoRoot, state({ ticket: 3 }));
    writeRaw("{ not json");

    expect(listed()).toEqual([
      { readable: true, state: state({ ticket: 3 }) },
      { readable: false, ticket: TICKET },
    ]);
  });

  it("names the Version a file it cannot read says wrote it", () => {
    writeRaw(JSON.stringify({ version: "9.9.0", somethingNewer: "from a later Version" }));

    expect(listed()).toEqual([{ readable: false, ticket: TICKET, version: "9.9.0" }]);
  });

  it("names no Version for a file that is not JSON at all", () => {
    writeRaw("{ not json");

    expect(listed()).toEqual([{ readable: false, ticket: TICKET }]);
  });

  it("names no Version where the file holds something that is not one", () => {
    writeRaw(JSON.stringify({ version: 4, state: "merged" }));

    expect(listed()).toEqual([{ readable: false, ticket: TICKET }]);
  });

  it("reads a file whose Ticket disagrees with its name as one it cannot read", () => {
    writeRaw(JSON.stringify(state({ ticket: TICKET + 1, version: "0.4.0" })));

    expect(listed()).toEqual([{ readable: false, ticket: TICKET, version: "0.4.0" }]);
  });

  it("ignores anything in the directory that is not a Ticket's state", () => {
    writeTicketState(repoRoot, state({ ticket: 3 }));
    mkdirSync(join(repoRoot, ".agent-pipeline", "state"), { recursive: true });
    writeFileSync(join(repoRoot, ".agent-pipeline", "state", "notes.txt"), "a human's note");

    expect(listed().map(readableState).map((recorded) => recorded?.ticket)).toEqual([3]);
  });
});

/** The state a file holds, where it holds one a Run could resume from. */
function readableState(file: StateFile): TicketState | undefined {
  return file.readable ? file.state : undefined;
}
