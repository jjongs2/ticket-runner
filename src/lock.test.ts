import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, lockHeldMessage, lockHolder, lockPath } from "./lock.js";

let repoRoot: string;

function holder(overrides: Partial<Parameters<typeof acquireLock>[1]> = {}) {
  return {
    pid: 4321,
    command: "agent-pipeline run",
    runId: "run-1",
    startedAt: "2026-09-17T09:00:00.000Z",
    ...overrides,
  };
}

const nothingAlive = { checkProcess: () => ({ alive: false }) as const };
const everythingAlive = { checkProcess: () => ({ alive: true, startedAt: undefined }) as const };

/** A fake process table: alive with the given start time, dead for any other pid. */
function processes(byPid: Record<number, string>) {
  return {
    checkProcess: (pid: number) =>
      pid in byPid ? ({ alive: true, startedAt: byPid[pid] } as const) : ({ alive: false } as const),
  };
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "agent-pipeline-lock-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("acquireLock", () => {
  it("writes the holder where a human can read it", () => {
    const outcome = acquireLock(repoRoot, holder(), everythingAlive);

    expect(outcome.ok).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(repoRoot), "utf8"))).toEqual(holder());
  });

  it("refuses a second Run and names the holder", () => {
    acquireLock(repoRoot, holder({ pid: 111, runId: "first" }), everythingAlive);

    const outcome = acquireLock(repoRoot, holder({ pid: 222 }), everythingAlive);

    expect(outcome).toEqual({ ok: false, holder: holder({ pid: 111, runId: "first" }) });
  });

  it("refuses a `ticket` started while a `run` holds the lock", () => {
    acquireLock(repoRoot, holder({ command: "agent-pipeline run" }), everythingAlive);

    const outcome = acquireLock(
      repoRoot,
      holder({ pid: 222, command: "agent-pipeline ticket 5" }),
      everythingAlive,
    );

    expect(outcome.ok).toBe(false);
  });

  it("reclaims a lock whose process is no longer alive", () => {
    acquireLock(repoRoot, holder({ pid: 111, runId: "crashed" }), everythingAlive);

    const outcome = acquireLock(repoRoot, holder({ pid: 222, runId: "second" }), nothingAlive);

    expect(outcome.ok).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(repoRoot), "utf8")).runId).toBe("second");
  });

  it("reclaims a lock file too corrupt to name a holder", () => {
    acquireLock(repoRoot, holder(), everythingAlive);
    writeFileSync(lockPath(repoRoot), "{ not json");

    expect(acquireLock(repoRoot, holder({ pid: 222 }), everythingAlive).ok).toBe(true);
  });

  it("frees the lock for the next Run when released", () => {
    const first = acquireLock(repoRoot, holder(), everythingAlive);
    if (!first.ok) throw new Error("expected the first Run to take the lock");

    first.release();

    expect(existsSync(lockPath(repoRoot))).toBe(false);
    expect(acquireLock(repoRoot, holder({ pid: 222 }), everythingAlive).ok).toBe(true);
  });

  it("asks the real process table when no seam is given", () => {
    // pid 1 always exists; signal 0 answers EPERM rather than ESRCH when it is
    // owned by another user, and EPERM still means alive.
    acquireLock(repoRoot, holder({ pid: 1 }));

    expect(acquireLock(repoRoot, holder({ pid: process.pid })).ok).toBe(false);
  });

  it("records the holder's own start time, so a recycled pid cannot forge it", () => {
    acquireLock(repoRoot, holder({ pid: 111 }), processes({ 111: "A" }));

    expect(JSON.parse(readFileSync(lockPath(repoRoot), "utf8")).processStartedAt).toBe("A");
  });

  it("takes a lock whose recorded pid is alive but is a different process now", () => {
    acquireLock(repoRoot, holder({ pid: 111, runId: "crashed" }), processes({ 111: "A" }));

    // pid 111 is alive again, but its start time no longer matches: a stranger.
    const outcome = acquireLock(
      repoRoot,
      holder({ pid: 222, runId: "second" }),
      processes({ 222: "C", 111: "B" }),
    );

    expect(outcome.ok).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(repoRoot), "utf8")).runId).toBe("second");
  });

  it("still refuses, and still names the holder, when the recorded pid is still it", () => {
    acquireLock(repoRoot, holder({ pid: 111, runId: "first" }), processes({ 111: "A" }));

    const outcome = acquireLock(
      repoRoot,
      holder({ pid: 222 }),
      processes({ 222: "C", 111: "A" }),
    );

    expect(outcome).toEqual({
      ok: false,
      holder: holder({ pid: 111, runId: "first", processStartedAt: "A" }),
    });
  });

  it("takes the lock when the holder's own start time cannot be read", () => {
    // `everythingAlive` answers alive with no start time, which is exactly
    // what an unsupported platform, or a pid the read failed for, looks like.
    const outcome = acquireLock(repoRoot, holder({ pid: 111 }), everythingAlive);

    expect(outcome.ok).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(repoRoot), "utf8")).processStartedAt).toBeUndefined();
  });
});

describe("lockHeldMessage", () => {
  it("names the command, run and pid holding the lock", () => {
    const message = lockHeldMessage(holder(), repoRoot);

    expect(message).toContain("`agent-pipeline run`");
    expect(message).toContain("run run-1");
    expect(message).toContain("pid 4321");
    expect(message).toContain(lockPath(repoRoot));
  });
});

describe("lockHolder", () => {
  it("names the Run holding the lock", () => {
    acquireLock(repoRoot, holder(), everythingAlive);

    expect(lockHolder(repoRoot, everythingAlive)).toEqual(holder());
  });

  it("names nobody when no Run has taken the lock", () => {
    expect(lockHolder(repoRoot, everythingAlive)).toBeUndefined();
  });

  it("names nobody once the holder's process is gone, and leaves the file", () => {
    acquireLock(repoRoot, holder(), everythingAlive);

    expect(lockHolder(repoRoot, nothingAlive)).toBeUndefined();
    // Reclaiming a dead lock belongs to the next Run, not to whoever reads it.
    expect(existsSync(lockPath(repoRoot))).toBe(true);
  });

  it("names nobody for a lock file too corrupt to name one", () => {
    acquireLock(repoRoot, holder(), everythingAlive);
    writeFileSync(lockPath(repoRoot), "{ not json");

    expect(lockHolder(repoRoot, everythingAlive)).toBeUndefined();
  });

  it("asks the real process table when no seam is given", () => {
    acquireLock(repoRoot, holder({ pid: process.pid }));

    expect(lockHolder(repoRoot)?.pid).toBe(process.pid);
  });

  it("names nobody once the recorded pid belongs to a different process, and leaves the file", () => {
    acquireLock(repoRoot, holder({ pid: 111 }), processes({ 111: "A" }));

    expect(lockHolder(repoRoot, processes({ 111: "B" }))).toBeUndefined();
    expect(existsSync(lockPath(repoRoot))).toBe(true);
  });
});
