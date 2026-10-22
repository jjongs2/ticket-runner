import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Killing a command together with everything it started.
 *
 * The command's own process group would not do: a Stage shares the Run's
 * process group (ADR-0006), so that group is the Run itself, and Claude Code
 * starts each Bash tool command in a session of its own, so the test suite a
 * Stage runs is in no group the Stage is in. What is killed instead is the
 * command, every process descended from it, and every process group one of
 * them leads.
 *
 * A process whose parent has exited is no longer descended from anything the
 * command started: the shell that ran `cmd &` in a Bash call exits, and `cmd`
 * lives on under init in a group of its own. A command given a mark carries an
 * environment variable whose value nothing else on the Host shares, and every
 * process it starts inherits it, so the kill also takes every process that
 * still carries that value, whoever its parent is by then. The environment is
 * read from `/proc/<pid>/environ` where there is a `/proc`, as on Linux, and
 * from `ps -wwE` where there is not, as on macOS. A process whose environment
 * cannot be read, or that cleared it, is reached by the walk alone.
 */

/** How often a kill looks for what is still alive while the grace runs. */
const POLL_MS = 50;

/** One line of the process table, as far as a kill needs it. */
interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
}

/** A variable only one command and what it starts carry, at this value. */
export interface Mark {
  name: string;
  value: string;
}

/**
 * Which processes on the Host carry the mark. Throws, or answers nothing, when
 * no environment can be read; a test hands in its own.
 */
export type FindMarked = (mark: Mark) => number[];

export interface KillOptions {
  /** The mark the command was started with, when it was given one. */
  mark?: Mark;
  findMarked?: FindMarked;
}

/** A command's processes as one kill signals them. */
interface Tree {
  pids: Set<number>;
  /** Process groups led by one of the pids, never the Run's own. */
  groups: Set<number>;
}

/**
 * SIGTERM to the command and everything it started, then SIGKILL to whatever
 * is still there once `graceMs` is over. Settles when nothing it signalled is
 * left, or once the SIGKILL is sent.
 */
export async function killTree(
  root: number,
  graceMs: number,
  options: KillOptions = {},
): Promise<void> {
  const marked = () => markedPids(options);
  const tree = treeOf([root, ...marked()]);
  signal(tree, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!anyAlive(tree)) {
      // What it signalled is gone, but one of them may have started another
      // as it went: that one still carries the mark.
      const late = treeOf(marked().filter((pid) => alive(pid)));
      if (late.pids.size === 0) return;
      signal(late, "SIGTERM");
      for (const pid of late.pids) tree.pids.add(pid);
      for (const group of late.groups) tree.groups.add(group);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  // Walked and looked for again from what survived: a process can start
  // another in the grace.
  const stragglers = treeOf([...tree.pids].filter((pid) => alive(pid)).concat(marked()));
  for (const group of tree.groups) stragglers.groups.add(group);
  signal(stragglers, "SIGKILL");
}

/**
 * The roots, their descendants and the groups those lead. Without `ps` to ask,
 * it is the roots alone.
 */
function treeOf(roots: number[]): Tree {
  const table = processTable();
  if (table === undefined) return { pids: new Set(roots), groups: new Set() };

  const children = new Map<number, number[]>();
  for (const row of table) {
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  }
  const pids = new Set<number>();
  const queue = [...roots];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    if (pids.has(pid)) continue;
    pids.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }

  const own = table.find((row) => row.pid === process.pid)?.pgid;
  const groups = new Set(
    table
      .filter((row) => pids.has(row.pid) && row.pgid === row.pid && row.pgid !== own)
      .map((row) => row.pgid),
  );
  return { pids, groups };
}

/**
 * The processes carrying the mark, never this one. None when there is no mark,
 * or when its read failed: the walk still reaches what it reaches.
 */
function markedPids({ mark, findMarked = processesMarked }: KillOptions): number[] {
  if (mark === undefined) return [];
  try {
    return findMarked(mark).filter((pid) => pid !== process.pid);
  } catch {
    return [];
  }
}

/** The processes carrying the mark, read from `/proc` or else from `ps`. */
export function processesMarked(mark: Mark): number[] {
  const entries = procEntries();
  if (entries === undefined) return markedInPs(psWithEnvironment(), mark);

  const wanted = asEntry(mark);
  return entries.flatMap((pid) => {
    try {
      const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
      return environ.split("\0").includes(wanted) ? [pid] : [];
    } catch {
      // Gone since the listing, or another user's: the walk alone reaches it.
      return [];
    }
  });
}

/** The mark as an environment holds it. */
function asEntry(mark: Mark): string {
  return `${mark.name}=${mark.value}`;
}

/** The pids under `/proc`, or nothing on a Host without one. */
function procEntries(): number[] | undefined {
  try {
    return readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).map(Number);
  } catch {
    return undefined;
  }
}

/**
 * Every process with its environment appended to its command, as BSD `ps`
 * prints it. `-ww` because it cuts its lines when stdout is not a terminal,
 * `-A` because a detached process has no terminal to be listed under.
 */
function psWithEnvironment(): string {
  const listed = spawnSync("ps", ["-A", "-wwE", "-o", "pid=,command="], { encoding: "utf8" });
  if (listed.error !== undefined) throw listed.error;
  if (listed.status !== 0) throw new Error(`ps exited ${listed.status}`);
  return listed.stdout;
}

/**
 * The processes in `ps -wwE -o pid=,command=` output that carry the mark, as
 * one whitespace-separated `NAME=value` word in their line.
 */
export function markedInPs(output: string, mark: Mark): number[] {
  const wanted = asEntry(mark);
  return output.split("\n").flatMap((line) => {
    const [pid, ...words] = line.trim().split(/\s+/);
    if (pid === undefined || !/^\d+$/.test(pid)) return [];
    return words.includes(wanted) ? [Number(pid)] : [];
  });
}

/** Every process on the Host, or nothing when `ps` cannot be run. */
function processTable(): ProcessRow[] | undefined {
  const listed = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" });
  if (listed.error !== undefined || listed.status !== 0) return undefined;
  return listed.stdout.split("\n").flatMap((line) => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || pgid === undefined) return [];
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) return [];
    return [{ pid, ppid, pgid }];
  });
}

function signal(tree: Tree, name: NodeJS.Signals): void {
  for (const group of tree.groups) send(-group, name);
  for (const pid of tree.pids) send(pid, name);
}

function anyAlive(tree: Tree): boolean {
  return [...tree.groups].some((group) => alive(-group)) || [...tree.pids].some(alive);
}

/** A negative id is a process group. */
function alive(id: number): boolean {
  return send(id, 0);
}

/** Whether the signal reached anything; one already gone is not an error here. */
function send(id: number, name: NodeJS.Signals | 0): boolean {
  try {
    process.kill(id, name);
    return true;
  } catch {
    return false;
  }
}
