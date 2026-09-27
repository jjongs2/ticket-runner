import { readdirSync } from "node:fs";
import { join } from "node:path";
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
 * It lives on the Target's remote, where a Run on any Host finds it; where
 * exactly is the git-backed Workspace's business
 * ({@link import("./ports/workspace.js").Workspace.readState} and the rest).
 * This is only what the file says and what its name is, which that Workspace
 * reads and writes through here. Whether the branch a file names is still there
 * is the Workspace's other question, and whether the Ticket is released or
 * stranded is the Claim's, read off GitHub.
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

/** One file per Ticket, named for it. */
export function stateFileName(ticket: number): string {
  return `ticket-${ticket}.json`;
}

/** The name {@link stateFileName} gives, read back the other way. */
const STATE_FILE = /^ticket-(\d+)\.json$/;

/** The Ticket a file of that name is about, or undefined for any other file. */
export function stateFileTicket(name: string): number | undefined {
  const match = STATE_FILE.exec(name);
  return match === null ? undefined : Number.parseInt(match[1] as string, 10);
}

/** What the file holds: JSON a human can read without the pipeline. */
export function stateFileContents(state: TicketState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * What the file `ticket` keeps says, and which of the two things it is.
 *
 * A file that is not JSON, one missing what resuming needs, and one a newer
 * pipeline shaped differently are all unreadable: starting the Ticket over is
 * always safe, and resuming on a guess is not. So is one that names another
 * Ticket than its own name does, which no Version would resume either.
 */
export function readStateFile(contents: string, ticket: number): StateFile {
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

/** The file's JSON, or undefined where it is not JSON — which the schema refuses. */
function parseJson(contents: string): unknown {
  try {
    return JSON.parse(contents);
  } catch {
    return undefined;
  }
}

/** Where a pipeline before the state branch kept the State files, in the checkout. */
export const LOCAL_STATE_DIR = join(".ticket-runner", "state");

/**
 * The Tickets whose State files a pipeline before the state branch left in this
 * checkout, in ascending number.
 *
 * Nothing reads them any more, and nothing migrates them (ADR-0004): a Run that
 * finds any refuses to start, because each is a Ticket a Run would otherwise
 * take from the top, or never sweep at all, without a word.
 */
export function localStateTickets(repoRoot: string): number[] {
  let entries: string[];
  try {
    entries = readdirSync(join(repoRoot, LOCAL_STATE_DIR));
  } catch {
    // No directory at all: no earlier pipeline ever claimed anything here.
    return [];
  }
  return entries.flatMap((entry) => stateFileTicket(entry) ?? []).sort((a, b) => a - b);
}
