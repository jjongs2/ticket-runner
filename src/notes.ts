/**
 * What a Stage does with a finding that is not this Ticket's business.
 *
 * A Stage that meets a defect in code it was not sent to touch has three bad
 * options and one good one. Fixing it widens the Ticket past the Acceptance
 * Criteria the Verdict grades. Ignoring it loses it. Writing it into the
 * Ticket's own comments buries it under a Ticket that is about to close. So it
 * records a **Note** instead, and the pipeline puts the Note where somebody
 * will meet it: the comments of the Ticket it belongs to, or the standing
 * Notes issue when it belongs to none yet.
 *
 * Notes ride along with the implement and fix Stages' structured output, which
 * is the only reason those Stages have any. A Stage with nothing to report
 * emits an empty list and is not treated differently for it.
 */

import type { StageName } from "./ports/agent-runner.js";
import type { Tracker } from "./ports/tracker.js";
import {
  NOTES_ISSUE_TITLE,
  type NoteSubject,
  isNotesIssue,
  noteComment,
  notesIssue,
} from "./templates.js";
import { z } from "zod";

/** One finding, and the Ticket it belongs to when the Stage knew of one. */
export interface Note {
  ticket?: number;
  note: string;
}

/** A Note that reached GitHub, which is what a Run summary reports. */
export interface RoutedNote {
  /** The Ticket whose Stage made the finding. */
  origin: number;
  stage: StageName;
  /** The issue the Note reached: the Ticket it named, or the standing Notes issue. */
  issue: number;
  /**
   * Whether the pipeline opened that issue for it, which is true of one Note at
   * most: the one that found no standing Notes issue open and needed one.
   */
  opened: boolean;
  note: string;
}

/**
 * One entry of a Stage's `notes` list.
 *
 * `ticket` is read separately from `note` and forgiven separately: a number the
 * Stage wrote as a string, a float or a zero is no number, but the words beside
 * it are still a finding. Dropping the entry over its label would lose exactly
 * what this whole module exists to keep.
 */
const noteSchema = z.object({
  ticket: z.number().int().positive().optional().catch(undefined),
  note: z.string(),
});

/**
 * The `--json-schema` the implement and fix Stages are invoked with.
 *
 * `ticket` is optional on purpose: a Stage that guesses a number puts the Note
 * on an unrelated issue, where a Stage that leaves it out gets a comment on the
 * standing Notes issue a human reads. Not knowing is an answer.
 */
export const NOTES_JSON_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      description:
        "Findings that belong to another Ticket, or to no Ticket yet. Empty when you found none.",
      items: {
        type: "object",
        properties: {
          ticket: {
            type: "number",
            description:
              "The issue number this belongs to. Omit it unless you are sure which one.",
          },
          note: {
            type: "string",
            description:
              "What you found and why it matters, in plain sentences. Open with one short sentence that names the finding and put the detail after it. No checkboxes.",
          },
        },
        required: ["note"],
        additionalProperties: false,
      },
    },
  },
  required: ["notes"],
  additionalProperties: false,
} as const;

/**
 * The Notes in a Stage's structured output, and nothing else from it.
 *
 * Forgiving at every level, because a Stage that reported its work badly has
 * still done the work: output that is not an object, a missing list, an entry
 * the schema rejects and an entry with no words in it each cost that one entry
 * and leave the rest. The alternative is a Ticket that fails over a malformed
 * aside.
 */
export function parseNotes(result: unknown): Note[] {
  if (typeof result !== "object" || result === null) return [];
  const raw = (result as { notes?: unknown }).notes;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((item) => {
    const parsed = noteSchema.safeParse(item);
    if (!parsed.success || parsed.data.note.trim() === "") return [];
    const { ticket, note } = parsed.data;
    return [ticket === undefined ? { note } : { ticket, note }];
  });
}

/** What it takes to find the standing Notes issue, or to open one. */
export interface StandingNotesLookup {
  tracker: Tracker;
  /** The label the standing Notes issue wears, and the one it is looked for under. */
  needsTriage: string;
  log?: (line: string) => void;
}

/**
 * The standing Notes issue of a Run: the one issue every triage-bound Note
 * becomes a comment on.
 *
 * A Run has one of these and every Ticket it drives shares it, so the lookup
 * happens once however many Notes the night makes, and two Lanes writing Notes
 * at the same time cannot open two issues: the first call starts the resolution
 * and the second waits on the same promise. The Run lock already makes two Runs
 * on one Target impossible, so single-flight in one process is the whole of
 * what a race needs.
 *
 * A failed resolution is forgotten rather than remembered: the Note that asked
 * for it is lost, as any Note a tracker refuses is, and the next one asks
 * again rather than inheriting an outage that may be over.
 */
export class StandingNotes {
  /** The search for an issue already open, which a Run runs at most once. */
  #found: Promise<number | undefined> | undefined;

  /** The issue this Run resolved, found or opened, and who gets to say it opened it. */
  #standing: Promise<{ number: number; opened: boolean }> | undefined;

  /**
   * The standing Notes issue's number when one is open, and nothing when none
   * is. Opens none: this is what a Stage prompt is told, and a prompt is no
   * reason to put an issue on GitHub.
   *
   * A lookup that fails answers with nothing rather than throwing. A Stage that
   * is not told the number writes its Notes anyway, where a Stage that never
   * ran writes none at all.
   */
  async current(lookup: StandingNotesLookup): Promise<number | undefined> {
    try {
      if (this.#standing !== undefined) return (await this.#standing).number;
      return await this.#search(lookup);
    } catch (error) {
      lookup.log?.(
        `could not look up the standing Notes issue: ${(error as Error).message}`,
      );
      return undefined;
    }
  }

  /**
   * The standing Notes issue's number, opening one when none is open.
   *
   * `opened` is true for the one Note that needed the issue opened and false
   * for every Note after it, which is what a Run summary reports.
   */
  async resolve(lookup: StandingNotesLookup): Promise<{ number: number; opened: boolean }> {
    this.#standing ??= this.#findOrOpen(lookup);
    let resolved: { number: number; opened: boolean };
    try {
      resolved = await this.#standing;
    } catch (error) {
      this.#standing = undefined;
      throw error;
    }
    const opened = resolved.opened;
    resolved.opened = false;
    return { number: resolved.number, opened };
  }

  async #findOrOpen(
    lookup: StandingNotesLookup,
  ): Promise<{ number: number; opened: boolean }> {
    const found = await this.#search(lookup);
    if (found !== undefined) return { number: found, opened: false };

    const issue = await lookup.tracker.createIssue({
      ...notesIssue(),
      labels: [lookup.needsTriage],
    });
    lookup.log?.(`opened #${issue.number} to gather Notes for triage`);
    return { number: issue.number, opened: true };
  }

  #search(lookup: StandingNotesLookup): Promise<number | undefined> {
    this.#found ??= findStandingNotes(lookup).catch((error: unknown) => {
      this.#found = undefined;
      throw error;
    });
    return this.#found;
  }
}

/**
 * The open issue carrying the standing Notes marker, or nothing.
 *
 * The title is a fast path and never a proof: the candidates that carry it are
 * read first, and an issue that carries it without the marker is somebody
 * else's and is never written to. Where none of them confirms — there is no
 * standing issue yet, or a human renamed the one there is — the rest of the
 * open `needs-triage` issues are read for the marker. That is a read per
 * candidate, paid once per Run, and only until a marked issue exists to be
 * found by its title.
 *
 * Lowest number first, so two marked issues a human left open resolve to the
 * same one every time rather than to whichever the tracker listed first.
 */
async function findStandingNotes({
  tracker,
  needsTriage,
}: StandingNotesLookup): Promise<number | undefined> {
  const candidates = [...(await tracker.listCandidates(needsTriage))].sort(
    (a, b) => a.number - b.number,
  );
  const named = (title: string) => title.trim() === NOTES_ISSUE_TITLE;
  const ordered = [
    ...candidates.filter((candidate) => named(candidate.title)),
    ...candidates.filter((candidate) => !named(candidate.title)),
  ];

  for (const candidate of ordered) {
    const issue = await tracker.getIssue(candidate.number);
    if (isNotesIssue(issue.body)) return candidate.number;
  }
  return undefined;
}

export interface NoteRouting extends StandingNotesLookup {
  /** The Ticket whose Stage made the findings. */
  origin: number;
  stage: StageName;
  /** The label a claimed Ticket wears, which a Note reads as "do not comment here". */
  inProgress: string;
  /** The Run's standing Notes issue, which every triage-bound Note goes to. */
  standing: StandingNotes;
}

/**
 * Put every Note in a Stage's output where somebody will meet it.
 *
 * One Note that cannot be posted — a Ticket number the Stage invented, a
 * tracker that refused the write — costs that Note and no more. Nothing here
 * may end a Ticket: the Stage's own work is already committed, and a Ticket
 * handed to a human over a failed aside would be a worse outcome than the aside
 * being lost. So the failure is logged and the next Note is tried.
 */
export async function routeNotes(
  routing: NoteRouting,
  result: unknown,
): Promise<RoutedNote[]> {
  const routed: RoutedNote[] = [];

  for (const note of parseNotes(result)) {
    try {
      routed.push(await route(routing, note));
    } catch (error) {
      routing.log?.(
        `#${routing.origin} could not route a Note: ${(error as Error).message}`,
      );
    }
  }

  return routed;
}

/**
 * Where one Note goes: the Ticket it names, and otherwise the standing Notes
 * issue.
 *
 * A Note that names the Ticket its own Stage is working on names no Ticket, as
 * far as this is concerned. A Stage says that when it has found something the
 * Acceptance Criteria do not cover, and commenting on that Ticket would file
 * the finding under an issue that is about to be closed by the very Run that
 * made it. The standing Notes issue outlives the Run; the Ticket does not.
 *
 * The same holds for any Ticket nobody will read again. A closed Ticket is
 * finished. A claimed one has a Stage on it already — this Run's other Lane,
 * another Run, a human — that read the Ticket when it started and will close it
 * when it lands, so a comment posted meanwhile is read by nobody. A Spec is
 * never implemented at all; only its Tickets are. Each of these takes the
 * comment without complaint, which is exactly the problem: the write succeeds
 * and the finding is buried. So they go to the standing Notes issue with the
 * number they were meant for, and the comment says why.
 *
 * A Ticket that will not take the comment — a number the Stage invented, an
 * issue somebody locked — falls to the standing Notes issue as well, carrying
 * the number it was meant for. That issue is the fallback for everything,
 * because the one outcome this module exists to prevent is a finding going
 * nowhere.
 */
async function route(routing: NoteRouting, note: Note): Promise<RoutedNote> {
  const { tracker, origin, stage } = routing;
  const from = { origin, stage, note: note.note };

  if (note.ticket !== undefined && note.ticket !== origin) {
    let buried: string | undefined;
    try {
      buried = await buriedOn(routing, note.ticket);
      if (buried === undefined) {
        await tracker.comment(note.ticket, noteComment(from));
        routing.log?.(`#${origin} noted on #${note.ticket}`);
        return { origin, stage, issue: note.ticket, opened: false, note: note.note };
      }
    } catch (error) {
      routing.log?.(
        `#${origin} could not comment its Note on #${note.ticket} ` +
          `(${(error as Error).message}); sending it to triage instead`,
      );
      return await sendToTriage(routing, { ...from, intended: note.ticket });
    }
    routing.log?.(
      `#${origin} will not comment its Note on #${note.ticket}, which ${buried}; ` +
        "sending it to triage instead",
    );
    return await sendToTriage(routing, { ...from, intended: note.ticket, because: buried });
  }

  return await sendToTriage(routing, from);
}

/**
 * Why a comment on this Ticket would be read by nobody, or nothing when it
 * would be read. The words are the ones the Note comment's provenance line
 * finishes with, after `which`.
 *
 * Claimed is the label alone, not the assignee with it: the pipeline's own
 * Claim writes both, but a human who took a Ticket may have written only the
 * label, and either way there is somebody on it.
 */
async function buriedOn(routing: NoteRouting, ticket: number): Promise<string | undefined> {
  const issue = await routing.tracker.getIssue(ticket);
  if (issue.closed) return "is closed";
  if (issue.subIssues > 0) return "is a Spec";
  if (issue.labels.includes(routing.inProgress)) return "is claimed";
  return undefined;
}

/**
 * One Note, as a comment on the standing Notes issue — opening that issue first
 * where this Run is the one that needed it.
 *
 * A comment rather than an issue of its own because the same condition is met
 * by Stage after Stage, and a Target that opens an issue every time makes
 * triage a job of gathering duplicates rather than reading findings. The facets
 * are all kept; only the artifact they arrive in is one.
 */
async function sendToTriage(
  routing: NoteRouting,
  subject: NoteSubject,
): Promise<RoutedNote> {
  const { number, opened } = await routing.standing.resolve(routing);
  await routing.tracker.comment(number, noteComment(subject));
  routing.log?.(`#${routing.origin} noted on #${number} for triage`);
  return {
    origin: routing.origin,
    stage: routing.stage,
    issue: number,
    opened,
    note: subject.note,
  };
}
