import { blockedCandidates, frontier } from "./frontier.js";
import { type Pipeline, type TicketOutcome, processTicket } from "./orchestrator.js";

/**
 * What a Run has to show for itself: every Ticket it took, in the order it took
 * them, and the candidates it never got to reach.
 */
export interface RunResult {
  outcomes: TicketOutcome[];
  /** Candidates still held back by an open blocker when the Run ended. */
  blocked: number[];
}

/**
 * Drain the Frontier: take Tickets one at a time until nothing is left to pick.
 *
 * The Frontier is recomputed before every Ticket rather than snapshotted, so a
 * merge that closes a blocker puts the Ticket it unblocked into the same Run. A
 * Ticket that fails is handed off and the Run moves on: one bad Ticket must not
 * cost the rest of the night.
 */
export async function processRun(pipeline: Pipeline): Promise<RunResult> {
  const { tracker, config } = pipeline;
  const log = pipeline.log ?? (() => {});

  const outcomes: TicketOutcome[] = [];
  // Every Ticket this Run has taken. A Ticket normally leaves the candidate
  // list by being closed or relabelled; this is what stops a Run spinning on
  // one when that write does not land.
  const taken = new Set<number>();
  let blocked: number[] = [];

  for (;;) {
    const candidates = await tracker.listCandidates(config.labels.readyForAgent);
    blocked = blockedCandidates(candidates).map((candidate) => candidate.number);

    const next = frontier(candidates).find((candidate) => !taken.has(candidate.number));
    if (next === undefined) break;

    taken.add(next.number);
    outcomes.push(await processTicket(pipeline, next.number));
  }

  if (blocked.length > 0) {
    log(`Frontier blocked · ${blocked.map((ticket) => `#${ticket}`).join(" ")}`);
  }
  return { outcomes, blocked };
}
