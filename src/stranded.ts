import type { Issue, Tracker } from "./ports/tracker.js";
import type { StateFile, Workspace } from "./ports/workspace.js";

/**
 * The Tickets a Run that never came back left claimed, and how a later Run finds
 * them.
 *
 * A Run killed mid-Ticket releases nothing: the Claim stays on the board, the
 * State file on the Target's remote, and the branch on the remote as of its
 * last committing Stage. The Frontier cannot see such a Ticket — it is claimed —
 * so without this nobody would ever pick it up again, on this Host or another.
 *
 * Nothing here needs a process id. The Run lock allows one Run at a time
 * (ADR-0004), so a Run holding the lock that finds a State file whose Ticket
 * still carries this user's Claim knows the Run that wrote it is gone.
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
  /** Where the State is kept. */
  workspace: Workspace;
  /** The `in-progress` label, as this repo configured it. */
  inProgress: string;
  log?: (line: string) => void;
}

/**
 * Sweep the State the Workspace keeps on the remote for the Tickets this
 * pipeline still holds, whichever Host's Run claimed them.
 *
 * Four things can be behind a State file, and only one of them is stranded:
 *
 * - the Ticket still carries this user's Claim — stranded, and resumed in place
 * - the Claim has come off — a released Ticket, or one handed to a human, and
 *   neither is the sweep's: the Frontier picks up whichever of them is labelled
 *   `ready-for-agent`, and a `ready-for-human` Ticket waits, inert, until a
 *   human relabels it. Both are passed over in silence
 * - the Ticket has closed — there is nothing left to resume, so the file goes
 * - somebody else holds it now — a human took the Ticket over, and neither the
 *   Ticket nor the file is this Run's to touch; it is logged and left
 *
 * A Ticket the tracker cannot be asked about is left alone too: a `gh` that is
 * down says nothing about whose Ticket it is, and a Run must not resume, or
 * forget, a Ticket on a guess.
 */
export async function strandedTickets(sweep: StrandedSweep): Promise<StrandedTicket[]> {
  const { tracker, workspace, inProgress } = sweep;
  const log = sweep.log ?? (() => {});

  const files = await workspace.readAllStates();
  // Said before anything is asked of the tracker, because it is the one finding
  // here that needs nothing of it: the file is all the evidence there is.
  for (const file of files) if (!file.readable) log(unreadableLine(file));

  const recorded = files.flatMap((file) => (file.readable ? [file.state] : []));
  // Asked only when there is something to ask about, so a Run on a Target that
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
      await workspace.removeState(ticket);
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

/**
 * A State file nothing here can resume from, named rather than dropped.
 *
 * The file and the Claim are left exactly where they are. A Ticket carrying a
 * file this pipeline cannot use is one a newer pipeline probably wrote, and
 * deleting either would take a Claim off the board that the machine which
 * understands the file is still counting on (ADR-0007). So the sweep says the
 * Ticket number and whichever Version the file names, and a human decides.
 *
 * `cannot use` rather than `cannot read`, because the two files that land here
 * are not the same: one will not parse at all, and one parses but names another
 * Ticket than the file it is in, which no Version would resume either.
 */
function unreadableLine(file: Extract<StateFile, { readable: false }>): string {
  const wrote = file.version === undefined ? "naming no Version" : `written by ${file.version}`;
  return `#${file.ticket} has a State file this Version cannot use, ${wrote}; it and the Claim are left alone`;
}
