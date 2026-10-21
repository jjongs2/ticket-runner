import { spawnSync } from "node:child_process";

/**
 * Killing a command together with everything it started.
 *
 * The command's own process group would not do: a Stage shares the Run's
 * process group (ADR-0006), so that group is the Run itself, and Claude Code
 * starts each Bash tool command in a session of its own, so the test suite a
 * Stage runs is in no group the Stage is in. What is killed instead is the
 * command, every process descended from it, and every process group one of
 * them leads.
 */

/** How often a kill looks for what is still alive while the grace runs. */
const POLL_MS = 50;

/** One line of the process table, as far as a kill needs it. */
interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
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
export async function killTree(root: number, graceMs: number): Promise<void> {
  const tree = treeOf([root]);
  signal(tree, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!anyAlive(tree)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  // Walked again from what survived: a process can start another in the grace.
  const stragglers = treeOf([...tree.pids].filter((pid) => alive(pid)));
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
