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
  /**
   * The Version that wrote the file (ADR-0007). Written on every write, and
   * optional when read: a file an earlier pipeline left names none, and a
   * Ticket claimed before this existed still resumes.
   */
  version?: string;
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
  version: z.string().optional(),
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
 * What a State file turned out to be.
 *
 * Three cases, not two: no file at all, a file that reads as state a Run can
 * resume from, and a file that does not. The third used to be the first —
 * silently dropped — and it is the one that most needs saying out loud: its
 * Ticket is claimed on the board, so the sweep for Stranded Tickets is the only
 * thing that could ever have found it (ADR-0007).
 */
export type StateFile =
  | { readable: true; state: TicketState }
  | {
      readable: false;
      /** Read off the file's name, which is the only part of it that parsed. */
      ticket: number;
      /** The Version the file names, where it names one a reader can make out. */
      version?: string;
    };

/**
 * What an earlier Run recorded about this Ticket, if it can be believed.
 *
 * A file nothing wrote, one that is not JSON, and one a newer pipeline shaped
 * differently all read as no state at all: starting the Ticket over is always
 * safe, and resuming on a guess is not.
 */
export function readTicketState(repoRoot: string, ticket: number): TicketState | undefined {
  const file = readStateFile(repoRoot, ticket);
  return file?.readable === true ? file.state : undefined;
}

/**
 * The file itself, and which of the three things it is. Undefined is the first:
 * nothing has ever recorded this Ticket here.
 */
export function readStateFile(repoRoot: string, ticket: number): StateFile | undefined {
  const contents = readFile(statePath(repoRoot, ticket));
  if (contents === undefined) return undefined;

  const raw = parseJson(contents);
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success || parsed.data.ticket !== ticket) {
    const version = namedVersion(raw);
    return { readable: false, ticket, ...(version === undefined ? {} : { version }) };
  }

  // A pull request nobody opened, and a Version an older pipeline never wrote,
  // are keys that are not there rather than keys holding nothing: the rest of
  // the pipeline reads these with the same distinction.
  const { pullRequest, version, ...state } = parsed.data;
  return {
    readable: true,
    state: {
      ...state,
      ...(pullRequest === undefined ? {} : { pullRequest }),
      ...(version === undefined ? {} : { version }),
    },
  };
}

/**
 * The Version a file that will not parse still names, where it names one.
 *
 * Read off the raw JSON rather than the schema, because the schema is exactly
 * what refused the file: a State file a newer pipeline wrote is named by the
 * Version that wrote it, whatever else about it this one cannot read.
 */
function namedVersion(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object" || !("version" in raw)) return undefined;
  const version = (raw as { version: unknown }).version;
  return typeof version === "string" && version !== "" ? version : undefined;
}

/**
 * Every State file this checkout holds, in ascending Ticket number.
 *
 * Ascending because a Run takes the oldest Ticket first, and the sweep that
 * reads this runs before the Frontier. A file that cannot be read is in the
 * list rather than missing from it: its Ticket is claimed, and the sweep is
 * what tells a human it is there.
 */
export function listStateFiles(repoRoot: string): StateFile[] {
  return recordedTickets(repoRoot)
    .sort((a, b) => a - b)
    .flatMap((ticket) => readStateFile(repoRoot, ticket) ?? []);
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

/** What is on disk, or undefined where there is no file to read at all. */
function readFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The file's JSON, or undefined where it is not JSON — which the schema refuses. */
function parseJson(contents: string): unknown {
  try {
    return JSON.parse(contents);
  } catch {
    return undefined;
  }
}
