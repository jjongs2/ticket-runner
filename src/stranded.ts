import type { Issue, Tracker } from "./ports/tracker.js";
import { clearTicketState, listTicketStates } from "./resume.js";

/**
 * The Tickets a Run that never came back left claimed, and how a later Run finds
 * them.
 *
 * A Run killed mid-Ticket releases nothing: the Claim stays on the board, and
 * the branch, worktree and State file stay on the machine. The Frontier cannot
 * see such a Ticket — it is claimed — so without this nobody would ever pick it
 * up again.
 *
 * Nothing here needs a process id. The Run lock allows one Run per checkout and
 * the State file is local to that checkout (ADR-0004), so a Run holding the lock
 * that finds a State file whose Ticket still carries this user's Claim knows the
 * Run that wrote it is gone.
 */

/** A Ticket still claimed by a Run that never came back, and where its work is. */
export interface StrandedTicket {
  number: number;
  title: string;
  /** The branch the State file named, which is where the work actually is. */
  branch: string;
}

/**
 * Whether this issue carries this user's Claim: assigned to them and labelled
 * `in-progress`, which is what {@link import("./orchestrator.js").processTicket}
 * writes when it claims a Ticket. Both halves, because a Ticket holding only one
 * of them is one nobody can say is being worked on.
 */
export function holdsClaim(issue: Issue, user: string, inProgress: string): boolean {
  return issue.assignees.includes(user) && issue.labels.includes(inProgress);
}

export interface StrandedSweep {
  tracker: Tracker;
  repoRoot: string;
  /** The `in-progress` label, as this repo configured it. */
  inProgress: string;
  log?: (line: string) => void;
}

/**
 * Sweep the local State files for the Tickets this checkout is still holding.
 *
 * Four things can be behind a State file, and only one of them is stranded:
 *
 * - the Ticket still carries this user's Claim — stranded, and resumed in place
 * - the Claim has come off — a released Ticket, which the Frontier picks up on
 *   its own terms, so the sweep leaves it where it is
 * - the Ticket has closed — there is nothing left to resume, so the file goes
 * - somebody else holds it now — a human took the Ticket over, and neither the
 *   Ticket nor the file is this Run's to touch; it is logged and left
 *
 * A Ticket the tracker cannot be asked about is left alone too: a `gh` that is
 * down says nothing about whose Ticket it is, and a Run must not resume, or
 * forget, a Ticket on a guess.
 */
export async function strandedTickets(sweep: StrandedSweep): Promise<StrandedTicket[]> {
  const { tracker, repoRoot, inProgress } = sweep;
  const log = sweep.log ?? (() => {});

  const recorded = listTicketStates(repoRoot);
  // Asked only when there is something to ask about, so a Run on a checkout that
  // has never claimed anything spends no call on the sweep.
  if (recorded.length === 0) return [];
  const user = await tracker.currentUser();

  const stranded: StrandedTicket[] = [];
  for (const state of recorded) {
    const ticket = state.ticket;
    let issue: Issue;
    try {
      issue = await tracker.getIssue(ticket);
    } catch (error) {
      log(`#${ticket} is resumable, but reading it failed: ${(error as Error).message}`);
      continue;
    }

    if (issue.closed) {
      clearTicketState(repoRoot, ticket);
      log(`#${ticket} has closed, so the state it left is gone`);
      continue;
    }
    if (issue.assignees.length > 0 && !issue.assignees.includes(user)) {
      log(`#${ticket} is resumable, but ${issue.assignees.join(", ")} holds it now`);
      continue;
    }
    if (!holdsClaim(issue, user, inProgress)) continue;

    stranded.push({ number: ticket, title: issue.title, branch: state.branch });
  }

  return stranded;
}
