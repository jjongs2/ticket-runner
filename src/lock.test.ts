import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LockOptions,
  lockHeldMessage,
  lockHolder,
  lockPath,
  releaseLock,
  takeLock,
  takeOverLock,
} from "./lock.js";
import type { LockHolder, LockOutcome } from "./ports/workspace.js";

let repoRoot: string;

function holder(overrides: Partial<LockHolder> = {}) {
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

/** The lock as a starting Run takes it: an abandoned one is taken over. */
function acquire(root: string, next: LockHolder, options: LockOptions = {}): LockOutcome {
  const found = takeLock(root, next, options);
  return found.outcome === "abandoned" ? takeOverLock(root, next, options) : found;
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "agent-pipeline-lock-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("taking the lock", () => {
  it("writes the holder where a human can read it", () => {
    const outcome = acquire(repoRoot, holder(), everythingAlive);

    expect(outcome.outcome).toBe("taken");
    expect(JSON.parse(readFileSync(lockPath(repoRoot), "utf8"))).toEqual(holder());
  });

  it("refuses a second Run and names the holder", () => {
    acquire(repoRoot, holder({ pid: 111, runId: "first" }), everythingAlive);

    const outcome = acquire(repoRoot, holder({ pid: 222 }), everythingAlive);

    expect(outcome).toEqual({ outcome: "held", holder: holder({ pid: 111, runId: "first" }) });
  });

  it("refuses a `ticket` started while a `run` holds the lock", () => {
    acquire(repoRoot, holder({ command: "agent-pipeline run" }), everythingAlive);

    const outcome = acquire(
      repoRoot,
      holder({ pid: 222, command: "agent-pipeline ticket 5" }),
      everythingAlive,
    );

    expect(outcome.outcome).toBe("held");
  });

  it("reclaims a lock whose process is no longer alive", () => {
    acquire(repoRoot, holder({ pid: 111, runId: "crashed" }), everythingAlive);

    const outcome = acquire(repoRoot, holder({ pid: 222, runId: "second" }), nothingAlive);

    expect(outcome.outcome).toBe("taken");
    expect(JSON.parse(readFileSync(lockPath(repoRoot), "utf8")).runId).toBe("second");
  });

  it("reclaims a lock file too corrupt to name a holder", () => {
    acquire(repoRoot, holder(), everythingAlive);
    writeFileSync(lockPath(repoRoot), "{ not json");

    expect(acquire(repoRoot, holder({ pid: 222 }), everythingAlive).outcome).toBe("taken");
  });

  it("frees the lock for the next Run when released", () => {
    acquire(repoRoot, holder(), everythingAlive);

    releaseLock(repoRoot);

    expect(existsSync(lockPath(repoRoot))).toBe(false);
    expect(acquire(repoRoot, holder({ pid: 222 }), everythingAlive).outcome).toBe("taken");
  });

  it("asks the real process table when no seam is given", () => {
    // pid 1 always exists; signal 0 answers EPERM rather than ESRCH when it is
    // owned by another user, and EPERM still means alive.
    acquire(repoRoot, holder({ pid: 1 }));

    expect(acquire(repoRoot, holder({ pid: process.pid })).outcome).toBe("held");
  });

  it("records the holder's own start time, so a recycled pid cannot forge it", () => {
    acquire(repoRoot, holder({ pid: 111 }), processes({ 111: "A" }));

    expect(JSON.parse(readFileSync(lockPath(repoRoot), "utf8")).processStartedAt).toBe("A");
  });

  it("takes a lock whose recorded pid is alive but is a different process now", () => {
    acquire(repoRoot, holder({ pid: 111, runId: "crashed" }), processes({ 111: "A" }));

    // pid 111 is alive again, but its start time no longer matches: a stranger.
    const outcome = acquire(
      repoRoot,
      holder({ pid: 222, runId: "second" }),
      processes({ 222: "C", 111: "B" }),
    );

    expect(outcome.outcome).toBe("taken");
    expect(JSON.parse(readFileSync(lockPath(repoRoot), "utf8")).runId).toBe("second");
  });

  it("still refuses, and still names the holder, when the recorded pid is still it", () => {
    acquire(repoRoot, holder({ pid: 111, runId: "first" }), processes({ 111: "A" }));

    const outcome = acquire(
      repoRoot,
      holder({ pid: 222 }),
      processes({ 222: "C", 111: "A" }),
    );

    expect(outcome).toEqual({
      outcome: "held",
      holder: holder({ pid: 111, runId: "first", processStartedAt: "A" }),
    });
  });

  it("takes the lock when the holder's own start time cannot be read", () => {
    // `everythingAlive` answers alive with no start time, which is exactly
    // what an unsupported platform, or a pid the read failed for, looks like.
    const outcome = acquire(repoRoot, holder({ pid: 111 }), everythingAlive);

    expect(outcome.outcome).toBe("taken");
    expect(JSON.parse(readFileSync(lockPath(repoRoot), "utf8")).processStartedAt).toBeUndefined();
  });
});

describe("taking the lock in two steps", () => {
  it("finds a lock whose process is gone abandoned, and leaves it for the take-over", () => {
    takeLock(repoRoot, holder({ pid: 111, runId: "crashed" }), everythingAlive);

    const found = takeLock(repoRoot, holder({ pid: 222 }), nothingAlive);

    expect(found).toEqual({ outcome: "abandoned" });
    expect(JSON.parse(readFileSync(lockPath(repoRoot), "utf8")).runId).toBe("crashed");
  });

  it("takes over an abandoned lock", () => {
    takeLock(repoRoot, holder({ pid: 111, runId: "crashed" }), everythingAlive);

    const outcome = takeOverLock(repoRoot, holder({ pid: 222, runId: "second" }), nothingAlive);

    expect(outcome).toEqual({ outcome: "taken" });
    expect(JSON.parse(readFileSync(lockPath(repoRoot), "utf8")).runId).toBe("second");
  });

  it("takes nothing over from a holder that is running again by the time it is asked", () => {
    takeLock(repoRoot, holder({ pid: 111, runId: "first" }), everythingAlive);

    const outcome = takeOverLock(repoRoot, holder({ pid: 222 }), processes({ 111: "A" }));

    expect(outcome).toEqual({ outcome: "held", holder: holder({ pid: 111, runId: "first" }) });
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
    acquire(repoRoot, holder(), everythingAlive);

    expect(lockHolder(repoRoot, everythingAlive)).toEqual(holder());
  });

  it("names nobody when no Run has taken the lock", () => {
    expect(lockHolder(repoRoot, everythingAlive)).toBeUndefined();
  });

  it("names nobody once the holder's process is gone, and leaves the file", () => {
    acquire(repoRoot, holder(), everythingAlive);

    expect(lockHolder(repoRoot, nothingAlive)).toBeUndefined();
    // Reclaiming a dead lock belongs to the next Run, not to whoever reads it.
    expect(existsSync(lockPath(repoRoot))).toBe(true);
  });

  it("names nobody for a lock file too corrupt to name one", () => {
    acquire(repoRoot, holder(), everythingAlive);
    writeFileSync(lockPath(repoRoot), "{ not json");

    expect(lockHolder(repoRoot, everythingAlive)).toBeUndefined();
  });

  it("asks the real process table when no seam is given", () => {
    acquire(repoRoot, holder({ pid: process.pid }));

    expect(lockHolder(repoRoot)?.pid).toBe(process.pid);
  });

  it("names nobody once the recorded pid belongs to a different process, and leaves the file", () => {
    acquire(repoRoot, holder({ pid: 111 }), processes({ 111: "A" }));

    expect(lockHolder(repoRoot, processes({ 111: "B" }))).toBeUndefined();
    expect(existsSync(lockPath(repoRoot))).toBe(true);
  });
});
