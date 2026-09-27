import { describe, expect, it } from "vitest";
import type { Host } from "./host.js";
import {
  FREE_LOCK,
  checkProcessTable,
  holderStanding,
  lockCommitMessage,
  lockFileContents,
  lockHeldMessage,
  readLockFile,
} from "./lock.js";
import type { LockHolder } from "./ports/workspace.js";

const HERE: Host = { kind: "workstation", id: "4f1c0ffee", name: "desk" };
const CLOUD: Host = { kind: "cloud", id: "session_01abc", name: "runsc" };

function holder(overrides: Partial<LockHolder> = {}): LockHolder {
  return {
    host: HERE,
    pid: 4321,
    command: "ticket-runner run",
    runId: "run-1",
    startedAt: "2026-09-17T09:00:00.000Z",
    ...overrides,
  };
}

/** A fake process table: alive with the given start time, dead for any other pid. */
function processes(byPid: Record<number, string | undefined>) {
  return (pid: number) =>
    pid in byPid ? ({ alive: true, startedAt: byPid[pid] } as const) : ({ alive: false } as const);
}

describe("the lock file", () => {
  it("reads back the holder it was written for", () => {
    const written = holder({ processStartedAt: "A" });

    expect(readLockFile(lockFileContents(written))).toEqual(written);
  });

  it("says it is held, so a human reading it on GitHub need not guess", () => {
    expect(JSON.parse(lockFileContents(holder()))).toMatchObject({ held: true, runId: "run-1" });
  });

  it("names nobody when it is free", () => {
    expect(lockFileContents(undefined).trim()).toBe(FREE_LOCK);
    expect(readLockFile(lockFileContents(undefined))).toBeUndefined();
  });

  it("names nobody for whatever else a human commits to release it", () => {
    expect(readLockFile("")).toBeUndefined();
    expect(readLockFile("free")).toBeUndefined();
    expect(readLockFile('{ "held": false, "pid": 4321 }')).toBeUndefined();
  });

  it("names nobody for a held file that names no Host or no process", () => {
    const { host: _host, ...hostless } = holder();
    expect(readLockFile(JSON.stringify({ held: true, ...hostless }))).toBeUndefined();
    expect(
      readLockFile(JSON.stringify({ held: true, ...holder(), pid: "4321" })),
    ).toBeUndefined();
  });
});

describe("the lock commit's message", () => {
  it("names the Run and the Host holding the Target", () => {
    expect(lockCommitMessage(holder({ host: CLOUD }))).toBe(
      "Held by run run-1 on the cloud Host of session `session_01abc`: ticket-runner run",
    );
  });

  it("says Free when nobody does", () => {
    expect(lockCommitMessage(undefined)).toBe("Free");
  });
});

describe("a holder's standing", () => {
  it("is running while its process on this Host is", () => {
    expect(holderStanding(holder(), HERE, processes({ 4321: undefined }))).toBe("running");
  });

  it("is abandoned once its process on this Host has gone", () => {
    expect(holderStanding(holder(), HERE, processes({}))).toBe("abandoned");
  });

  it("is abandoned when its pid is alive but is a different process now", () => {
    const recycled = processes({ 4321: "B" });

    expect(holderStanding(holder({ processStartedAt: "A" }), HERE, recycled)).toBe("abandoned");
  });

  it("is still running when the recorded pid is still it", () => {
    const same = processes({ 4321: "A" });

    expect(holderStanding(holder({ processStartedAt: "A" }), HERE, same)).toBe("running");
  });

  it("is elsewhere on another Host, and no process here is asked about it", () => {
    const asked: number[] = [];
    const standing = holderStanding(holder({ host: CLOUD }), HERE, (pid) => {
      asked.push(pid);
      return { alive: false };
    });

    expect(standing).toBe("elsewhere");
    expect(asked).toEqual([]);
  });

  it("is elsewhere on another machine of the same kind", () => {
    const desk = { ...HERE, id: "another-machine" };

    expect(holderStanding(holder({ host: desk }), HERE, processes({}))).toBe("elsewhere");
  });
});

describe("the process table", () => {
  it("finds this process alive, with a start time where the platform keeps one", () => {
    const check = checkProcessTable(process.pid);

    expect(check.alive).toBe(true);
    if (process.platform === "linux" && check.alive) expect(check.startedAt).toBeDefined();
  });

  it("finds pid 1 alive even when it belongs to another user", () => {
    // Signal 0 answers EPERM rather than ESRCH for a process owned by another
    // user, and EPERM still means alive.
    expect(checkProcessTable(1).alive).toBe(true);
  });
});

describe("lockHeldMessage", () => {
  it("names the command, run and pid of a Run on this Host, and says to wait", () => {
    const message = lockHeldMessage({ holder: holder(), onAnotherHost: false });

    expect(message).toContain("`ticket-runner run`");
    expect(message).toContain("run run-1");
    expect(message).toContain("pid 4321");
    expect(message).toContain("Wait for it to finish");
  });

  it("names another Host, the Run and its start, and how the lock is released", () => {
    const message = lockHeldMessage({ holder: holder({ host: CLOUD }), onAnotherHost: true });

    expect(message).toContain("the cloud Host of session `session_01abc`");
    expect(message).toContain("run run-1");
    expect(message).toContain("started 2026-09-17T09:00:00.000Z");
    expect(message).toContain("through an Operator");
    expect(message).toContain("free tip to the `ticket-runner/lock` branch");
    expect(message).toContain(FREE_LOCK);
    expect(message).not.toContain("pid");
  });

  it("names a workstation by its hostname", () => {
    const desk = { kind: "workstation" as const, id: "another-machine", name: "laptop" };
    const message = lockHeldMessage({ holder: holder({ host: desk }), onAnotherHost: true });

    expect(message).toContain("the workstation `laptop`");
  });
});
