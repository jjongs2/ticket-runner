import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Whether a process, or a process group, is still alive.
 *
 * `process.kill(id, 0)` alone would not say: it still succeeds on a zombie, a
 * process that is dead but not yet reaped, and a killed orphan stays one until
 * the machine's init reaps it, which on a cloud Host takes seconds and in a
 * PID namespace whose init never reaps takes forever. The kill and the tests
 * of it both judge by this.
 */

/**
 * Whether the process is alive: running, sleeping or stopped. A zombie is not,
 * though it can still be signalled. Where its state cannot be read at all, the
 * signal's answer stands.
 */
export function alive(pid: number): boolean {
  if (!signalled(pid)) return false;
  const state = stateOf(pid);
  if (state === null) return true;
  return state !== undefined && !isDead(state);
}

/**
 * Whether any process in the group is alive, by the same judgement. Where the
 * process table cannot be read, the signal's answer stands.
 */
export function groupAlive(pgid: number): boolean {
  if (!signalled(-pgid)) return false;
  const listed = spawnSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8" });
  if (listed.error !== undefined || listed.status !== 0) return true;
  return listed.stdout.split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === pgid && state !== undefined && !isDead(state);
  });
}

/** Whether a signal 0 reaches anything; a negative id is a process group. */
function signalled(id: number): boolean {
  try {
    process.kill(id, 0);
    return true;
  } catch {
    return false;
  }
}

/** Zombie, or on Linux dead and on its way out of the table. */
function isDead(state: string): boolean {
  return state.startsWith("Z") || state.startsWith("X");
}

/**
 * The process's state letters, read from `/proc` where there is one and from
 * `ps` where there is not; `undefined` once it has left the process table, and
 * `null` when there is neither to ask.
 */
function stateOf(pid: number): string | undefined | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return stateFromPs(pid);
  }
  // `pid (comm) state ...`, where comm may itself hold spaces and parentheses.
  return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0];
}

/** The state `ps` prints for the process, nothing once it has gone, `null` without `ps`. */
function stateFromPs(pid: number): string | undefined | null {
  const listed = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  if (listed.error !== undefined) return null;
  const state = listed.stdout.trim();
  return listed.status === 0 && state !== "" ? state : undefined;
}
