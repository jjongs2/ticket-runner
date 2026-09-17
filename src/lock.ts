import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * One Run at a time per repo.
 *
 * Two Runs sharing a checkout would fight over `main`, over the same Frontier
 * and over the same worktrees. The lock is a PID file rather than an advisory
 * lock so a Run killed mid-flight leaves something a human can read, and so the
 * next Run can tell a live holder from a stale file.
 */

export interface LockHolder {
  pid: number;
  /** The command line the holder is running, for the message the loser prints. */
  command: string;
  runId: string;
  /** ISO 8601, so the file is readable without the pipeline. */
  startedAt: string;
}

export type LockOutcome =
  | { ok: true; release: () => void }
  | { ok: false; holder: LockHolder };

export interface LockOptions {
  /** Seam for tests; defaults to signal 0 against the real process table. */
  isAlive?: (pid: number) => boolean;
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
  { isAlive = processIsAlive }: LockOptions = {},
): LockOutcome {
  const path = lockPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const contents = `${JSON.stringify(holder, null, 2)}\n`;

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
    if (existing !== undefined && isAlive(existing.pid)) {
      return { ok: false, holder: existing };
    }
    // Gone, or a file too corrupt to name anyone to wait for.
    rmSync(path, { force: true });
  }

  throw new Error(`another process keeps taking the Run lock at ${path}`);
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
  };
}

/** Signal 0 tests for existence without delivering anything. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Alive, just owned by another user.
    return errorCode(error) === "EPERM";
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
