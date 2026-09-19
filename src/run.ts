import { branchName } from "./branch.js";
import { selectFrontier } from "./frontier.js";
import type { RoutedNote } from "./notes.js";
import { type Pipeline, type TicketOutcome, processTicket } from "./orchestrator.js";
import { strandedTickets } from "./stranded.js";

/**
 * What a Run has to show for itself: every Ticket it took, in the order they
 * ended, and why it stopped taking them.
 *
 * The order is completion rather than claim because Lanes run side by side: two
 * Tickets claimed in the same breath finish whenever their own Stages let them,
 * and the summary reads as the night happened rather than as it was planned.
 */
export interface RunResult {
  outcomes: TicketOutcome[];
  stop: RunStop;
}

/**
 * Why a Run ended.
 *
 * A Run that drained the Frontier carries what was left held back; one the rate
 * limit stopped carries nothing, because it ended before it could say a
 * candidate was held back all Run. That is why this is a choice rather than a
 * flag beside the list: the two stops do not report the same things.
 */
export type RunStop =
  | {
      reason: "frontier";
      /** Candidates still held back by an open blocker when the Run ended. */
      blocked: number[];
    }
  | { reason: "rate-limited" };

/**
 * Drain the Frontier through the Lanes the Target's config gives the Run.
 *
 * Every free Lane is filled at once, and a Lane is filled again the moment the
 * Ticket in it ends — merged, handed off or released. The Frontier is recomputed
 * at every refill rather than snapshotted, so a merge that closes a blocker puts
 * the Ticket it unblocked into the same Run, and a Ticket another Lane is still
 * working is still an open blocker. Those edges are the whole of what keeps two
 * Tickets apart: no heuristic here decides which are safe together.
 *
 * A Ticket that fails is handed off and the Lane moves on: one bad Ticket must
 * not cost the rest of the night.
 *
 * A Release stops the Run filling Lanes and nothing more. Nothing was wrong with
 * the Ticket — the subscription ran out of room — so the next one would be
 * stopped by the same limit, and claiming it would spend a Claim, a worktree and
 * a doomed Stage to learn what the first one already said. The Lanes still busy
 * finish what they hold, and the Run reports the limit once the last of them
 * comes back.
 *
 * Before any of that, the Tickets a Run that never came back left claimed are
 * resumed. They are not on the Frontier and never will be — the Claim they still
 * wear is what keeps them off it — so this sweep is the only thing that ever
 * picks them up again, and a free Lane takes one before it takes anything the
 * Frontier is offering.
 */
export async function processRun(pipeline: Pipeline): Promise<RunResult> {
  const { tracker, config } = pipeline;

  const outcomes: TicketOutcome[] = [];
  // Every Ticket this Run has taken. A Ticket normally leaves the candidate
  // list by being closed or relabelled; this is what stops a Run offering one
  // to a second Lane, whether because that write did not land or because the
  // Claim of the Lane holding it has not reached GitHub yet.
  const taken = new Set<number>();
  // The Lanes with a Ticket in them, by Ticket number. A Lane takes itself out
  // of here as its Ticket ends rather than where the Run waits, so a fill pass
  // that several Lanes came back during sees every one of them free.
  const busy = new Map<number, Promise<void>>();
  // What the last Frontier this Run computed held back, which is what a Run
  // that drained the Frontier reports. Replaced at every refill: a candidate a
  // Lane unblocked on the way is not one the Run was still held up by.
  let blocked: number[] = [];
  // Whether a Release has stopped this Run filling Lanes.
  let rateLimited = false;
  // A Frontier the tracker refused to list, kept until the Lanes still busy are
  // back. A Run must not walk away from a Ticket mid-Stage to report that `gh`
  // went down, so the error waits for them and is thrown where a Run with one
  // Lane threw it: out of the Run, with nothing else left running.
  let listing: unknown;

  // Taken off the front as Lanes free, so the sweep is a queue rather than a
  // pass of its own: a stranded Ticket and a Frontier Ticket can be in two
  // Lanes at once, and neither waits for the other's kind to run out.
  const stranded = await strandedTickets({
    tracker,
    repoRoot: pipeline.repoRoot,
    inProgress: config.labels.inProgress,
    ...(pipeline.log === undefined ? {} : { log: pipeline.log }),
  });

  /** Whether the Run has a Lane to put a Ticket in right now. */
  function laneFree(): boolean {
    return busy.size < config.lanes;
  }

  /**
   * Put a Ticket in a Lane, and record what came back when it ends.
   *
   * The line about the Run stopping is logged by the first Release only. The
   * Ticket's own release is already logged where it happened; this says the Run
   * goes no further, so a transcript shows the Frontier was left alone rather
   * than found empty, and a second Lane released afterwards stops nothing that
   * was not stopped already. It leads with the Ticket's number all the same: a
   * transcript of interleaved Lanes must not lose the line that explains why one
   * Lane was the last to be filled.
   */
  function fillLane(ticket: Taken): void {
    taken.add(ticket.number);
    busy.set(
      ticket.number,
      take(pipeline, ticket).then((outcome) => {
        busy.delete(ticket.number);
        outcomes.push(outcome);
        if (outcome.outcome === "released" && !rateLimited) {
          rateLimited = true;
          pipeline.log?.(`#${outcome.ticket} stopped the Run · rate limit`);
        }
      }),
    );
  }

  /** Fill every free Lane: the stranded Tickets first, the Frontier second. */
  async function fillLanes(): Promise<void> {
    while (laneFree()) {
      const resumable = stranded.shift();
      if (resumable === undefined) break;
      fillLane(resumable);
    }
    // Asked for only when a Lane is still free, so a Run whose Lanes are full of
    // stranded Tickets spends no call on a Frontier it could not take from.
    if (!laneFree()) return;

    const selection = selectFrontier(
      await tracker.listCandidates(config.labels.readyForAgent),
    );
    blocked = selection.blocked.map((candidate) => candidate.number);
    // Asked again after the listing, because a Lane that came back while it was
    // in flight may have been released: the Run fills no Lane after that, and
    // this selection is one it already had no business taking from.
    if (rateLimited) return;

    for (const candidate of selection.frontier) {
      if (!laneFree()) break;
      if (taken.has(candidate.number)) continue;
      fillLane({
        number: candidate.number,
        title: candidate.title,
        branch: branchName(candidate.number, candidate.title),
      });
    }
  }

  for (;;) {
    if (!rateLimited && listing === undefined) {
      try {
        await fillLanes();
      } catch (error) {
        listing = error;
      }
    }
    // Never while a Lane is busy, whatever the Frontier had to offer: that Lane
    // may be about to close the blocker the rest of the Frontier is waiting on.
    if (busy.size === 0) break;
    await Promise.race(busy.values());
  }

  if (listing !== undefined) throw listing;
  return rateLimited
    ? { outcomes, stop: { reason: "rate-limited" } }
    : { outcomes, stop: { reason: "frontier", blocked } };
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
