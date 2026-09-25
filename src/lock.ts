import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { type Host, describeHost, sameHost } from "./host.js";
import type { HeldLock, LockHolder } from "./ports/workspace.js";

/**
 * One Run at a time per Target, whichever Host it is on (ADR-0008).
 *
 * Two Runs sharing a Target would fight over its base branch, over the same
 * Frontier and over the same worktrees. The lock lives on the Target's GitHub
 * repository so every Host sees it: {@link LOCK_BRANCH} always exists, and its
 * tip's {@link LOCK_FILE} says who holds it or that nobody does. It is taken by
 * compare-and-swap, a "held" commit pushed with a lease on the tip the taker
 * read, and released by a "free" commit on top of that; nothing is ever
 * deleted, which a cloud Host could not do.
 *
 * This module is what the lock says and what it means: the file, the commit
 * message a human reads on GitHub, and whether a holder is still running. The
 * git-backed Workspace does the pushing
 * ({@link import("./ports/workspace.js").Workspace.takeRunLock} and the rest).
 */

/** The branch the lock lives on, under the prefix the pipeline owns. */
export const LOCK_BRANCH = "agent-pipeline/lock";

/** The file at the top of the lock branch's tip that says who holds it. */
export const LOCK_FILE = "lock.json";

/** What a free lock's file says, and what a human commits to release one. */
export const FREE_LOCK = '{ "held": false }';

/** Whether a pid is alive, and which process it is when it is. */
export type ProcessCheck = { alive: false } | { alive: true; startedAt: string | undefined };

/**
 * What a lock's holder is to a Run on `here`: still running, a process on this
 * same Host that has gone, or a Run on another Host, whose process nothing here
 * can see and which is therefore never presumed gone.
 */
export type HolderStanding = "running" | "abandoned" | "elsewhere";

export function holderStanding(
  holder: LockHolder,
  here: Host,
  checkProcess: (pid: number) => ProcessCheck,
): HolderStanding {
  if (!sameHost(holder.host, here)) return "elsewhere";
  return holderIsCurrent(holder, checkProcess(holder.pid)) ? "running" : "abandoned";
}

/** The lock file for `holder`, or a free one when nobody holds the lock. */
export function lockFileContents(holder: LockHolder | undefined): string {
  if (holder === undefined) return `${FREE_LOCK}\n`;
  return `${JSON.stringify({ held: true, ...holder }, null, 2)}\n`;
}

/**
 * The commit message a lock change carries, which is what GitHub shows beside
 * the branch: who holds the Target, or that nobody does.
 */
export function lockCommitMessage(holder: LockHolder | undefined): string {
  if (holder === undefined) return "Free";
  return `Held by run ${holder.runId} on ${describeHost(holder.host)}: ${holder.command}`;
}

/**
 * Who a lock file says holds the lock, or nobody.
 *
 * Only a file that says it is held, and names a Host and a process, is a
 * holder. Anything else — `{ "held": false }`, a file a human edited to say
 * something else, or no file at all — is a free lock, because that is how a
 * human releases one on GitHub, and the only writers of this file are the
 * pipeline and that human.
 */
export function readLockFile(contents: string): LockHolder | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const record = parsed as Partial<LockHolder> & { held?: unknown };
  const host = record.host as Partial<Host> | undefined;
  if (record.held !== true || !Number.isInteger(record.pid)) return undefined;
  if (host?.kind !== "workstation" && host?.kind !== "cloud") return undefined;
  if (typeof host.id !== "string" || host.id === "") return undefined;
  return {
    host: { kind: host.kind, id: host.id, name: typeof host.name === "string" ? host.name : host.id },
    pid: record.pid as number,
    command: record.command ?? "agent-pipeline",
    runId: record.runId ?? "unknown",
    startedAt: record.startedAt ?? "unknown",
    ...(typeof record.processStartedAt === "string"
      ? { processStartedAt: record.processStartedAt }
      : {}),
  };
}

/** The one line the Run that lost prints before exiting. */
export function lockHeldMessage({ holder, onAnotherHost }: HeldLock): string {
  if (!onAnotherHost) {
    return [
      `Another agent-pipeline is running on this Host: \`${holder.command}\``,
      `as run ${holder.runId} (pid ${holder.pid}, started ${holder.startedAt}).`,
      "Wait for it to finish, or ask it to with `agent-pipeline stop`.",
    ].join(" ");
  }
  return [
    `\`${holder.command}\` holds this Target as run ${holder.runId}`,
    `on ${describeHost(holder.host)}, started ${holder.startedAt}.`,
    releaseAdvice(),
  ].join(" ");
}

/**
 * What a Run that could not give the lock up says as it ends. The lock still
 * names it: a Run on this Host takes it over by itself, and a Run on any other
 * waits for a human.
 */
export function unreleasedLockMessage(reason: string): string {
  return (
    `Could not release the Run lock: ${reason}. It still names this Run on the ` +
    `\`${LOCK_BRANCH}\` branch. The next Run on this Host takes it over by itself; for a ` +
    `Run on any other Host, commit a \`${LOCK_FILE}\` that reads \`${FREE_LOCK}\` to that ` +
    "branch on GitHub, or ask an Operator to."
  );
}

/**
 * How a lock another Host holds is given up. Nothing here can tell whether
 * that Run is still going, so waiting comes first.
 */
function releaseAdvice(): string {
  return (
    "A Run on another Host is never presumed gone, so the lock stays until it is released: " +
    "wait for that Run to finish or, if it is gone, release the lock through an Operator, " +
    `or on GitHub by committing a free tip to the \`${LOCK_BRANCH}\` branch, a ` +
    `\`${LOCK_FILE}\` that reads \`${FREE_LOCK}\`.`
  );
}

/**
 * Whether a live process check still names the lock's recorded holder.
 *
 * A holder with no recorded start time is a claim where the start time could
 * not be read; a live pid is trusted alone, which is what every lock did
 * before this. Once a start time is recorded, though, a live pid this check
 * cannot itself read a start time for is not trusted as a match — a lock that
 * claims an identity this check cannot verify is not verified.
 */
function holderIsCurrent(holder: LockHolder, check: ProcessCheck): boolean {
  if (!check.alive) return false;
  if (holder.processStartedAt === undefined) return true;
  if (check.startedAt === undefined) return false;
  return check.startedAt === holder.processStartedAt;
}

/** Signal 0 tests for existence without delivering anything, then a start time. */
export function checkProcessTable(pid: number): ProcessCheck {
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
 * not recognise. Callers degrade to pid-only behaviour rather than fail: this
 * check can only add confidence, never cost a Run its lock.
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
