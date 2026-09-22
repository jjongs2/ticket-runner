import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * One Run at a time per Target.
 *
 * Two Runs sharing a Target would fight over its base branch, over the same
 * Frontier and over the same worktrees. The lock is a PID file rather than an
 * advisory lock so a Run killed mid-flight leaves something a human can read,
 * and so the next Run can tell a live holder from a stale file.
 */

export interface LockHolder {
  pid: number;
  /** The command line the holder is running, for the message the loser prints. */
  command: string;
  runId: string;
  /** ISO 8601, so the file is readable without the pipeline. */
  startedAt: string;
  /**
   * The holder process's start time as the operating system reports it, taken
   * when the lock was claimed. Distinct from `startedAt` above, which is the
   * Run's own wall clock, written for a human reading the file.
   *
   * A pid a lock names can be recycled — by a wrapped counter, or by a reboot
   * climbing back through the numbers a pre-reboot Run was using — so a live
   * pid alone cannot say the process behind it is still the holder. This is
   * what a recycled pid cannot forge. Absent when it could not be read, or
   * when the file predates this field; either way a live pid alone is treated
   * as the holder, which is what this check has always done.
   *
   * An opaque token, not a timestamp to parse or display: its shape is
   * whatever the platform's own record of it looks like (kernel ticks on
   * Linux, a `ps` field on macOS), good for nothing but comparing a pid's
   * past and present selves on the same host.
   */
  processStartedAt?: string;
}

export type LockOutcome =
  | { ok: true; release: () => void }
  | { ok: false; holder: LockHolder };

/** Whether a pid is alive, and which process it is when it is. */
export type ProcessCheck = { alive: false } | { alive: true; startedAt: string | undefined };

export interface LockOptions {
  /** Seam for tests; defaults to the real process table and its start times. */
  checkProcess?: (pid: number) => ProcessCheck;
}

/** The lock lives with the Run logs, under the gitignored run directory. */
export function lockPath(repoRoot: string): string {
  return join(repoRoot, ".agent-pipeline", "lock.json");
}

/**
 * Take the repo's Run lock, or report who holds it.
 *
 * A lock whose process is gone is reclaimed: the alternative is a crashed Run
 * blocking the repo until a human deletes a file they have never heard of.
 */
export function acquireLock(
  repoRoot: string,
  holder: LockHolder,
  { checkProcess = checkProcessTable }: LockOptions = {},
): LockOutcome {
  const path = lockPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });

  // The holder is always this process (`holder.pid` is `process.pid`), so its
  // own start time is read here rather than trusted from a caller a recycled
  // pid could impersonate just as easily as it impersonates the pid itself.
  const own = checkProcess(holder.pid);
  const recorded: LockHolder = {
    ...holder,
    ...(own.alive && own.startedAt !== undefined ? { processStartedAt: own.startedAt } : {}),
  };
  const contents = `${JSON.stringify(recorded, null, 2)}\n`;

  // Two passes: the first finds the file, the second takes it once the dead
  // holder has been cleared. A third would mean somebody is racing us for it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // `wx` is the whole mutual exclusion: creating the file is the claim.
      writeFileSync(path, contents, { flag: "wx" });
      return { ok: true, release: () => rmSync(path, { force: true }) };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    const existing = readHolder(path);
    if (existing !== undefined && holderIsCurrent(existing, checkProcess(existing.pid))) {
      return { ok: false, holder: existing };
    }
    // Gone, a recycled pid wearing someone else's identity, or a file too
    // corrupt to name anyone to wait for.
    rmSync(path, { force: true });
  }

  throw new Error(`another process keeps taking the Run lock at ${path}`);
}

/**
 * Who holds the Run lock, when anybody still does.
 *
 * Nobody covers all three ways there is no Run to reach: no lock file, a file
 * too corrupt to name one, and a holder whose process has gone. A dead lock is
 * left exactly where it is — reclaiming one belongs to `acquireLock`, on behalf
 * of a Run that is actually starting, where this only reads.
 */
export function lockHolder(
  repoRoot: string,
  { checkProcess = checkProcessTable }: LockOptions = {},
): LockHolder | undefined {
  const holder = readHolder(lockPath(repoRoot));
  if (holder === undefined || !holderIsCurrent(holder, checkProcess(holder.pid))) {
    return undefined;
  }
  return holder;
}

/** The one line the Run that lost prints before exiting. */
export function lockHeldMessage(holder: LockHolder, repoRoot: string): string {
  return [
    `Another agent-pipeline is running in this repo: \`${holder.command}\``,
    `as run ${holder.runId} (pid ${holder.pid}, started ${holder.startedAt}).`,
    `Wait for it to finish, or delete ${lockPath(repoRoot)} if you are sure it is gone.`,
  ].join(" ");
}

function readHolder(path: string): LockHolder | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const holder = parsed as Partial<LockHolder>;
  if (!Number.isInteger(holder.pid)) return undefined;
  return {
    pid: holder.pid as number,
    command: holder.command ?? "agent-pipeline",
    runId: holder.runId ?? "unknown",
    startedAt: holder.startedAt ?? "unknown",
    ...(typeof holder.processStartedAt === "string"
      ? { processStartedAt: holder.processStartedAt }
      : {}),
  };
}

/**
 * Whether a live process check still names the lock's recorded holder.
 *
 * A holder with no recorded start time is a file written before this check
 * existed, or a claim where the start time could not be read; either way a
 * live pid is trusted alone, which is what every lock did before this. Once a
 * start time is recorded, though, a live pid this check cannot itself read a
 * start time for is not trusted as a match — a lock that claims an identity
 * this check cannot verify is not verified.
 */
function holderIsCurrent(holder: LockHolder, check: ProcessCheck): boolean {
  if (!check.alive) return false;
  if (holder.processStartedAt === undefined) return true;
  if (check.startedAt === undefined) return false;
  return check.startedAt === holder.processStartedAt;
}

/** Signal 0 tests for existence without delivering anything, then a start time. */
function checkProcessTable(pid: number): ProcessCheck {
  if (!processIsAlive(pid)) return { alive: false };
  return { alive: true, startedAt: readProcessStartedAt(pid) };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Alive, just owned by another user.
    return errorCode(error) === "EPERM";
  }
}

/**
 * A pid's start time as the operating system reports it, or `undefined` when
 * it cannot be told — an unsupported platform (Windows has no answer here),
 * a pid already gone by the time this reads it, or anything else this does
 * not recognise. Callers degrade to today's pid-only behaviour rather than
 * fail: this check can only add confidence, never cost a Run its lock.
 */
function readProcessStartedAt(pid: number): string | undefined {
  try {
    if (process.platform === "linux") return linuxStartedAt(pid);
    if (process.platform === "darwin") return darwinStartedAt(pid);
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * `/proc/<pid>/stat`'s 22nd field, ticks since boot the kernel itself keeps.
 * Read past the process name in parentheses, which may itself contain a
 * space or a closing paren, by splitting on the last one in the line.
 */
function linuxStartedAt(pid: number): string | undefined {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  // Fields after the name start at state (3rd overall), so starttime (22nd)
  // sits at index 22 - 3 = 19 here.
  return afterComm[19];
}

/** `ps` is the closest thing macOS has to `/proc`; `lstart` is its absolute clock. */
function darwinStartedAt(pid: number): string | undefined {
  const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const trimmed = output.trim();
  return trimmed === "" ? undefined : trimmed;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
