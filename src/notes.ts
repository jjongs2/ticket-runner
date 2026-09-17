/**
 * What a Stage does with a finding that is not this Ticket's business.
 *
 * A Stage that meets a defect in code it was not sent to touch has three bad
 * options and one good one. Fixing it widens the Ticket past the Acceptance
 * Criteria the Verdict grades. Ignoring it loses it. Writing it into the
 * Ticket's own comments buries it under a Ticket that is about to close. So it
 * records a **Note** instead, and the pipeline puts the Note where somebody
 * will meet it: the comments of the Ticket it belongs to, or a fresh
 * `needs-triage` issue when it belongs to none yet.
 *
 * Notes ride along with the implement and fix Stages' structured output, which
 * is the only reason those Stages have any. A Stage with nothing to report
 * emits an empty list and is not treated differently for it.
 */

import type { StageName } from "./ports/agent-runner.js";
import type { Tracker } from "./ports/tracker.js";
import { noteComment, noteIssue } from "./templates.js";
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
  /** The issue the Note reached: the Ticket it named, or the one opened for it. */
  issue: number;
  /** Whether the pipeline opened that issue for it. */
  opened: boolean;
  note: string;
}

const noteSchema = z.object({
  ticket: z.number().int().positive().optional(),
  note: z.string(),
});

/**
 * The `--json-schema` the implement and fix Stages are invoked with.
 *
 * `ticket` is optional on purpose: a Stage that guesses a number puts the Note
 * on an unrelated issue, where a Stage that leaves it out gets a triage queue
 * entry a human reads. Not knowing is an answer.
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
              "What you found and why it matters, in plain sentences. No checkboxes.",
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

export interface NoteRouting {
  tracker: Tracker;
  /** The Ticket whose Stage made the findings. */
  origin: number;
  stage: StageName;
  /** The label a Note with no Ticket opens its issue under. */
  needsTriage: string;
  log?: (line: string) => void;
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
 * Where one Note goes.
 *
 * A Note that names the Ticket its own Stage is working on names no Ticket, as
 * far as this is concerned. A Stage says that when it has found something the
 * Acceptance Criteria do not cover, and commenting on that Ticket would file
 * the finding under an issue that is about to be closed by the very Run that
 * made it. The triage queue outlives the Run; the Ticket does not.
 */
async function route(routing: NoteRouting, note: Note): Promise<RoutedNote> {
  const { tracker, origin, stage } = routing;
  const from = { origin, stage, note: note.note };

  if (note.ticket !== undefined && note.ticket !== origin) {
    await tracker.comment(note.ticket, noteComment(from));
    routing.log?.(`#${origin} noted on #${note.ticket}`);
    return { origin, stage, issue: note.ticket, opened: false, note: note.note };
  }

  const issue = await tracker.createIssue({
    ...noteIssue(from),
    labels: [routing.needsTriage],
  });
  routing.log?.(`#${origin} noted as #${issue.number}`);
  return { origin, stage, issue: issue.number, opened: true, note: note.note };
}
