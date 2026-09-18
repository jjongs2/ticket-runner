import { branchName } from "./branch.js";
import { selectFrontier } from "./frontier.js";
import type { RoutedNote } from "./notes.js";
import { type Pipeline, type TicketOutcome, processTicket } from "./orchestrator.js";
import { strandedTickets } from "./stranded.js";

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
 *
 * Before any of that, the Tickets a Run that never came back left claimed are
 * resumed. They are not on the Frontier and never will be — the Claim they still
 * wear is what keeps them off it — so this sweep is the only thing that ever
 * picks them up again.
 */
export async function processRun(pipeline: Pipeline): Promise<RunResult> {
  const { tracker, config } = pipeline;

  const outcomes: TicketOutcome[] = [];
  // Every Ticket this Run has taken. A Ticket normally leaves the candidate
  // list by being closed or relabelled; this is what stops a Run spinning on
  // one when that write does not land — a resumed Ticket the rate limit releases
  // included, which lands straight back on the Frontier.
  const taken = new Set<number>();
  let blocked: number[] = [];

  const stranded = await strandedTickets({
    tracker,
    repoRoot: pipeline.repoRoot,
    inProgress: config.labels.inProgress,
    ...(pipeline.log === undefined ? {} : { log: pipeline.log }),
  });
  for (const ticket of stranded) {
    taken.add(ticket.number);
    outcomes.push(await take(pipeline, ticket));
  }

  for (;;) {
    const selection = selectFrontier(
      await tracker.listCandidates(config.labels.readyForAgent),
    );
    blocked = selection.blocked.map((candidate) => candidate.number);

    const next = selection.frontier.find((candidate) => !taken.has(candidate.number));
    if (next === undefined) break;

    taken.add(next.number);
    outcomes.push(
      await take(pipeline, {
        number: next.number,
        title: next.title,
        branch: branchName(next.number, next.title),
      }),
    );
  }

  return { outcomes, blocked };
}

/**
 * One Ticket, and never an exception.
 *
 * {@link processTicket} hands off everything it can, but its claim and its own
 * hand-off writes are outside that net: a tracker that goes down mid-Ticket
 * would otherwise take the whole Run with it. The Ticket is reported as handed
 * off — which, without the label, is what a human will find on the board.
 */
async function take(pipeline: Pipeline, ticket: Taken): Promise<TicketOutcome> {
  // Handed to the Ticket rather than read off its outcome, because there is no
  // outcome on this path: a Note already on GitHub has to reach the summary
  // whether or not the Ticket that made it came back.
  const notes: RoutedNote[] = [];
  try {
    return await processTicket(pipeline, ticket.number, notes);
  } catch (error) {
    const failure = (error as Error).message;
    pipeline.log?.(`#${ticket.number} failed outside the hand-off path: ${failure}`);
    return {
      outcome: "handed-off",
      ticket: ticket.number,
      title: ticket.title,
      branch: ticket.branch,
      stage: "setup",
      failure,
      notes,
    };
  }
}

/**
 * One Ticket a Run is about to take, named well enough to report on it when
 * nothing comes back.
 *
 * The branch is carried rather than derived, because the two ways a Run reaches
 * a Ticket know it differently: a candidate off the Frontier has whatever its
 * title derives to, and a stranded Ticket has the branch its State file names —
 * which is where the work actually is, whatever the title says now.
 */
interface Taken {
  number: number;
  title: string;
  branch: string;
}
