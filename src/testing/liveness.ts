import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Whether a process a test killed is gone.
 *
 * `process.kill(pid, 0)` alone would not say: it still succeeds on a zombie, a
 * process that is dead but not yet reaped, and a killed orphan stays one until
 * the machine's init reaps it, which on a cloud Host takes seconds.
 *
 * Scaffolding the tests are built from rather than a word the pipeline uses, so
 * it is not in `GLOSSARY.md`.
 */

/**
 * Whether the process is alive: running, sleeping or stopped. A zombie is not,
 * though it can still be signalled.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = stateOf(pid);
  return state !== undefined && !isDead(state);
}

/**
 * Asks {@link alive} until it says no, for about a second: a killed process
 * takes a moment to go.
 */
export async function goneSoon(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 20; tries += 1) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/** Zombie, or on Linux dead and on its way out of the table. */
function isDead(state: string): boolean {
  return state.startsWith("Z") || state.startsWith("X");
}

/**
 * The process's state letters, read from `/proc` where there is one and from
 * `ps` where there is not; nothing once it has left the process table.
 */
function stateOf(pid: number): string | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return stateFromPs(pid);
  }
  // `pid (comm) state ...`, where comm may itself hold spaces and parentheses.
  return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0];
}

/** The state `ps` prints for the process, or nothing once it has gone. */
function stateFromPs(pid: number): string | undefined {
  const listed = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  if (listed.error !== undefined) throw listed.error;
  const state = listed.stdout.trim();
  return listed.status === 0 && state !== "" ? state : undefined;
}
