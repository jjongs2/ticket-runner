/**
 * Ticking the Acceptance Criteria a verdict proved.
 *
 * A merged Ticket whose checkboxes are all still empty reads as unfinished
 * work, so the criteria verify marked `met` are ticked where they live — the
 * body, or the comment triage posted its brief in. Only `met` ones: an
 * `unverifiable` criterion is one nobody has evidence for, and a tick would
 * claim otherwise.
 *
 * The verdict answers each criterion by the number the pipeline listed it
 * under, so a met criterion is found again by the checkbox line it was listed
 * as, never by what the verify Stage wrote about it. A Ticket edited between
 * verify and the merge can leave that line reading otherwise, or twice; then
 * nothing is ticked for it, since a box left unticked only says the line moved,
 * where a wrong one claims a criterion was graded that never was.
 *
 * Nothing else in the text is touched. The pipeline is editing a human's
 * writing, so it rewrites three characters of a line it recognises and leaves
 * the line, and the document around it, as it found them.
 */

import { UNCHECKED_BOX } from "./acceptance-criteria.js";
import type { Tracker } from "./ports/tracker.js";
import type { Verdict } from "./verdict.js";

/** {@link UNCHECKED_BOX}, over every line of a text, capturing the rest of the line. */
const CHECKBOX_LINE = new RegExp(`${UNCHECKED_BOX}(.*)$`, "gm");

/** A met criterion, as ticking needs it: its number, and the line it was listed as. */
export interface MetCriterion {
  number: number;
  line: string;
}

/** A met criterion nothing was ticked for, and how many unticked lines read as its own. */
export interface Untickable {
  number: number;
  /** 0 when no line reads so any more, 2 or more when it is no longer one line. */
  matching: number;
}

/**
 * `texts` with the unticked box of each criterion in `met` ticked, the texts
 * being every place one Ticket writes its criteria: its body and its comments.
 *
 * A criterion is ticked on the one unticked checkbox line, across all the
 * texts together, that reads as the line it was listed as, trailing spaces
 * aside. None is ticked when no line, or more than one, reads so.
 *
 * Returns each text unchanged when nothing in it was ticked, which is how the
 * caller knows there is nothing to write back.
 */
export function tickCriteria(
  texts: readonly string[],
  met: readonly MetCriterion[],
): { texts: string[]; untickable: Untickable[] } {
  const open = texts.flatMap((text, place) =>
    [...text.matchAll(CHECKBOX_LINE)].map(({ index, 0: line }) => ({
      key: lineKey(place, index),
      line: line.trimEnd(),
    })),
  );

  const chosen = new Set<string>();
  const untickable: Untickable[] = [];
  for (const criterion of met) {
    const wanted = criterion.line.trimEnd();
    const matches = open.filter((line) => line.line === wanted);
    const [only] = matches;
    if (matches.length === 1 && only !== undefined) chosen.add(only.key);
    else untickable.push({ number: criterion.number, matching: matches.length });
  }
  if (chosen.size === 0) return { texts: [...texts], untickable };

  return {
    texts: texts.map((text, place) =>
      text.replaceAll(CHECKBOX_LINE, (line, bullet: string, rest: string, index: number) =>
        chosen.has(lineKey(place, index)) ? `${bullet}[x]${rest}` : line,
      ),
    ),
    untickable,
  };
}

/** One checkbox line on the whole Ticket: which text it is in, and where in it. */
function lineKey(place: number, index: number): string {
  return `${place}:${index}`;
}

/**
 * Tick every criterion the verdict proved, wherever the Ticket writes it.
 *
 * The issue is read again rather than reusing the copy it was claimed with: a
 * whole Run has happened since, and both the body and any comment are written
 * back whole. Triage posts its brief as a comment, and nothing says all the
 * criteria are in one place, so every comment is offered the same edit.
 *
 * A met criterion left unticked is said out loud rather than passed over in
 * silence: a merged Ticket with an unticked criterion is otherwise a mystery.
 */
export async function tickMetCriteria(
  tracker: Tracker,
  ticket: number,
  verdict: Verdict,
  log?: (line: string) => void,
): Promise<void> {
  const met = verdict.criteria.filter((criterion) => criterion.status === "met");
  if (met.length === 0) return;

  const issue = await tracker.getIssue(ticket);
  const { texts, untickable } = tickCriteria(
    [issue.body, ...issue.comments.map((comment) => comment.body)],
    met,
  );
  const [body = issue.body, ...comments] = texts;
  const unwritten: number[] = [];

  if (body !== issue.body) await tracker.updateIssueBody(ticket, body);

  for (const [place, comment] of issue.comments.entries()) {
    const edited = comments[place] ?? comment.body;
    if (edited === comment.body) continue;
    if (comment.id === undefined) {
      unwritten.push(...ticksIn(comment.body, edited, met));
      continue;
    }
    await tracker.updateComment(comment.id, edited);
  }

  const missed = [
    ...untickable.map(({ number, matching }) =>
      matching === 0
        ? `criterion ${number}, which no unticked line reads as any more`
        : `criterion ${number}, which ${matching} unticked lines read as`,
    ),
    ...unwritten.map((number) => `criterion ${number}, in a comment it cannot edit`),
  ];
  if (missed.length > 0) {
    log?.(
      `#${ticket} ticked ${met.length - missed.length} of ${met.length} met criteria; ` +
        `left unticked: ${missed.join("; ")}`,
    );
  }
}

/** The numbers of the criteria in `met` whose line an edit ticked, which leaves the line count as it was. */
function ticksIn(before: string, after: string, met: readonly MetCriterion[]): number[] {
  const now = after.split("\n");
  const changed = before
    .split("\n")
    .filter((line, index) => line !== now[index])
    .map((line) => line.trimEnd());
  return met
    .filter((criterion) => changed.includes(criterion.line.trimEnd()))
    .map((criterion) => criterion.number);
}
