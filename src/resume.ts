import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * The State file a claimed Ticket keeps, and what a later Run makes of it
 * (ADR-0004).
 *
 * A Ticket is resumable for as long as it is claimed, so the file is written as
 * part of the Claim and rewritten whenever the Ticket reaches something a later
 * Run should not pay for again. Two Runs read it. One is the Run that finds a
 * Ticket the subscription rate limit released: nothing was wrong with it, so the
 * Claim came off and this file says where to carry on from. The other is the Run
 * that finds a Ticket still claimed — the Run that claimed it was killed and
 * never released anything — and resumes it in place.
 *
 * It lives beside the branch and worktree it is about, and like them it is local
 * and gitignored.
 *
 * Nothing here talks to git or GitHub. Whether the branch and worktree the file
 * names are still there is the Workspace's question, and the orchestrator asks
 * it before resuming into them; whether the Ticket is released or stranded is
 * the Claim's, and it is read off GitHub.
 */

/**
 * How far a Ticket got: `claimed` is one the implement Stage never finished,
 * `implemented` one carrying that Stage's work on its branch with no merge
 * behind it.
 *
 * A state of the lifecycle, not a Stage — a Stage is a session (CONTEXT.md), and
 * what the file records is what the Ticket has, not what was running. Only these
 * two, because everything after the implement Stage — the Checks, the rebase,
 * the pull request, CI and the merge — is re-run from the top by a Run that
 * resumes at `implemented`, and none of them is worth a state a resume could
 * land on halfway.
 */
export const REACHED_STATES = ["claimed", "implemented"] as const;

export type ReachedState = (typeof REACHED_STATES)[number];

export interface TicketState {
  /** Carried in the file as well as its name, so the file reads on its own. */
  ticket: number;
  /** The branch the work is on, which the resuming Run uses rather than deriving. */
  branch: string;
  /** The state the Ticket had reached, which is where a later Run picks it up. */
  state: ReachedState;
  /**
   * Whether the Fix budget has been spent. Resuming must not hand the Ticket a
   * second fix Stage it never earned.
   */
  fixUsed: boolean;
  /**
   * The pull request the Ticket already has, if it got that far. Without it the
   * resuming Run would try to open a second one for the branch.
   */
  pullRequest?: number;
  /** The Run that last wrote the file, and when — both for a human reading it. */
  runId: string;
  /** ISO 8601. */
  updatedAt: string;
}

const stateSchema = z.object({
  ticket: z.number().int().positive(),
  branch: z.string().min(1),
  state: z.enum(REACHED_STATES),
  fixUsed: z.boolean(),
  pullRequest: z.number().int().positive().optional(),
  runId: z.string(),
  updatedAt: z.string(),
});

/** Where the State files live, under the same gitignored directory as the Run logs. */
function stateDir(repoRoot: string): string {
  return join(repoRoot, ".agent-pipeline", "state");
}

/** One file per Ticket. */
export function statePath(repoRoot: string, ticket: number): string {
  return join(stateDir(repoRoot), `ticket-${ticket}.json`);
}

export function writeTicketState(repoRoot: string, state: TicketState): void {
  const path = statePath(repoRoot, state.ticket);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Forget a Ticket is resumable, which every Ticket that ended is. */
export function clearTicketState(repoRoot: string, ticket: number): void {
  rmSync(statePath(repoRoot, ticket), { force: true });
}

/**
 * What an earlier Run recorded about this Ticket, if it can be believed.
 *
 * A file nothing wrote, one that is not JSON, and one a newer pipeline shaped
 * differently all read as no state at all: starting the Ticket over is always
 * safe, and resuming on a guess is not.
 */
export function readTicketState(repoRoot: string, ticket: number): TicketState | undefined {
  const parsed = stateSchema.safeParse(readJson(statePath(repoRoot, ticket)));
  if (!parsed.success || parsed.data.ticket !== ticket) return undefined;

  // A pull request nobody opened is a key that is not there, not a key holding
  // nothing: the rest of the pipeline reads these with the same distinction.
  const { pullRequest, ...state } = parsed.data;
  return { ...state, ...(pullRequest === undefined ? {} : { pullRequest }) };
}

/**
 * Every Ticket this checkout holds state for, in ascending number.
 *
 * Ascending because a Run takes the oldest Ticket first, and the sweep that
 * reads this runs before the Frontier. A file nothing can be resumed from is
 * left out rather than reported, exactly as {@link readTicketState} reads one.
 */
export function listTicketStates(repoRoot: string): TicketState[] {
  return recordedTickets(repoRoot)
    .sort((a, b) => a - b)
    .flatMap((ticket) => readTicketState(repoRoot, ticket) ?? []);
}

/** The name {@link statePath} writes, read back the other way. */
const STATE_FILE = /^ticket-(\d+)\.json$/;

function recordedTickets(repoRoot: string): number[] {
  let entries: string[];
  try {
    entries = readdirSync(stateDir(repoRoot));
  } catch {
    // No directory at all: nothing has ever been claimed on this checkout.
    return [];
  }
  return entries.flatMap((entry) => {
    const match = STATE_FILE.exec(entry);
    return match === null ? [] : [Number.parseInt(match[1] as string, 10)];
  });
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
