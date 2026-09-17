import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type TicketState,
  clearTicketState,
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
    stage: "implemented",
    fixUsed: false,
    runId: "run-1",
    releasedAt: "2026-09-17T09:00:00.000Z",
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
  it("writes one file per Ticket under the run directory", () => {
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
    writeTicketState(repoRoot, state({ stage: "claimed" }));
    writeTicketState(repoRoot, state({ stage: "implemented", fixUsed: true }));

    expect(readTicketState(repoRoot, TICKET)).toEqual(
      state({ stage: "implemented", fixUsed: true }),
    );
  });
});

describe("readTicketState", () => {
  it("reads back what the release recorded", () => {
    writeTicketState(repoRoot, state({ stage: "claimed", fixUsed: true }));

    expect(readTicketState(repoRoot, TICKET)).toEqual(state({ stage: "claimed", fixUsed: true }));
  });

  it("has nothing to say about a Ticket that was never released", () => {
    expect(readTicketState(repoRoot, TICKET)).toBeUndefined();
  });

  it("ignores a file that is not JSON at all", () => {
    writeRaw("{ not json");

    expect(readTicketState(repoRoot, TICKET)).toBeUndefined();
  });

  it("ignores a file that is missing what resuming needs", () => {
    writeRaw(JSON.stringify({ ticket: TICKET, stage: "implemented" }));

    expect(readTicketState(repoRoot, TICKET)).toBeUndefined();
  });

  it("ignores a state recorded for a different Ticket", () => {
    writeRaw(JSON.stringify(state({ ticket: 9 })));

    expect(readTicketState(repoRoot, TICKET)).toBeUndefined();
  });

  it("ignores a stage no Run knows how to resume from", () => {
    writeRaw(JSON.stringify({ ...state(), stage: "merged" }));

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
