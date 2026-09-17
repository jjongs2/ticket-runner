import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * The State file a released Ticket leaves behind, and what a later Run makes of
 * it (ADR-0004).
 *
 * A Ticket the subscription rate limit stopped has done nothing wrong, so it is
 * released rather than handed to a human: the Claim comes off and this file
 * stays, naming the state the Ticket reached so the next Run carries on from
 * there instead of paying for the Stages that already succeeded. It lives beside
 * the branch and worktree it is about, and like them it is local and gitignored.
 *
 * Nothing here talks to git or GitHub. Whether the branch and worktree the file
 * names are still there is the Workspace's question, and the orchestrator asks
 * it before resuming into them.
 */

/**
 * How far a released Ticket got, in the states of the lifecycle rather than the
 * Stages: `claimed` is a Ticket the implement Stage never finished, and
 * `implemented` one with the work on its branch but no merge behind it.
 *
 * Only the states a Stage can be rate-limited out of are here, because only
 * those can be released: the Checks, the rebase, the pull request, CI and the
 * merge run no agent session, so no rate limit can land on them.
 */
export const TICKET_STAGES = ["claimed", "implemented"] as const;

export type TicketStage = (typeof TICKET_STAGES)[number];

export interface TicketState {
  /** Carried in the file as well as its name, so the file reads on its own. */
  ticket: number;
  /** The branch the work is on, which the resuming Run uses rather than deriving. */
  branch: string;
  stage: TicketStage;
  /**
   * Whether the Fix budget was already spent when the rate limit came. Resuming
   * must not hand the Ticket a second fix Stage it never earned.
   */
  fixUsed: boolean;
  /**
   * The pull request the released Run had already opened, if it got that far.
   * Without it the resuming Run would try to open a second one for the branch.
   */
  pullRequest?: number;
  /** The Run that released the Ticket, and when — both for a human reading the file. */
  runId: string;
  /** ISO 8601. */
  releasedAt: string;
}

const stateSchema = z.object({
  ticket: z.number().int().positive(),
  branch: z.string().min(1),
  stage: z.enum(TICKET_STAGES),
  fixUsed: z.boolean(),
  pullRequest: z.number().int().positive().optional(),
  runId: z.string(),
  releasedAt: z.string(),
});

/** One file per Ticket, under the same gitignored directory as the Run logs. */
export function statePath(repoRoot: string, ticket: number): string {
  return join(repoRoot, ".agent-pipeline", "state", `ticket-${ticket}.json`);
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

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
