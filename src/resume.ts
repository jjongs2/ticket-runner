import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { REACHED_STATES, type StateFile, type TicketState } from "./ports/workspace.js";

/**
 * The State file a Ticket keeps while its branch carries work worth resuming,
 * and what a later Run makes of it (ADR-0004).
 *
 * A Ticket keeps the file for as long as there is work on its branch worth
 * resuming, so it is written as part of the Claim and rewritten whenever the
 * Ticket reaches something a later Run should not pay for again. Three Runs read
 * it, and what the board says decides which. One finds a Ticket the subscription
 * rate limit released: nothing was wrong with it, so the Claim came off and this
 * file says where to carry on from. One finds a Ticket still claimed — the Run
 * that claimed it was killed and never released anything — and resumes it in
 * place. One finds a Ticket a human was handed and has relabelled
 * `ready-for-agent`, which is the human handing it back. A Ticket still sitting
 * in `ready-for-human` is none of them: its file is inert until a human moves
 * the label or the issue closes.
 *
 * It lives beside the branch and worktree it is about, and like them it is local
 * and gitignored.
 *
 * This is how the git-backed Workspace keeps the State the port offers
 * ({@link import("./ports/workspace.js").Workspace.readState} and the rest):
 * nothing else reads or writes these files. Whether the branch and worktree a
 * file names are still there is the Workspace's other question, and whether the
 * Ticket is released or stranded is the Claim's, read off GitHub.
 */

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

/**
 * Forget a Ticket is resumable: on merge, when the sweep finds its issue closed,
 * when the worktree it names has gone, and on a hand-off over a branch no Stage
 * of the Run ever worked on.
 */
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
