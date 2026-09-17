/**
 * Ticking the Acceptance Criteria a Verdict proved.
 *
 * A merged Ticket whose checkboxes are all still empty reads as unfinished
 * work, so the criteria verify marked `met` are ticked where they live — the
 * body, or the comment triage posted its brief in. Only `met` ones: an
 * `unverifiable` criterion is one nobody has evidence for, and a tick would
 * claim otherwise.
 *
 * Nothing else in the text is touched. The pipeline is editing a human's
 * writing, so it rewrites three characters of a line it recognises and leaves
 * the line, and the document around it, as it found them.
 */

import type { Tracker } from "./ports/tracker.js";
import type { Verdict } from "./verdict.js";

/** A task list item: its bullet and indent, its box, and the text after it. */
const CHECKBOX_LINE = /^([ \t]*[-*+] )\[ \]( .*)$/gm;

/**
 * The same criterion as the verify Stage reported it.
 *
 * The Stage is asked for the criterion verbatim and mostly obliges, but it
 * reflows and recases often enough that an exact match would leave half a
 * Ticket unticked. Whitespace and case are the differences worth forgiving;
 * anything more and the risk is ticking a box nobody graded.
 */
function normalise(text: string): string {
  return text.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

/**
 * `text` with every unticked box whose criterion is in `met` ticked.
 *
 * Returns the text unchanged when nothing matched, which is how the caller
 * knows there is nothing to write back.
 */
export function tickCriteria(text: string, met: string[]): string {
  const wanted = new Set(met.map(normalise));
  if (wanted.size === 0) return text;

  return text.replaceAll(CHECKBOX_LINE, (line, bullet: string, rest: string) =>
    wanted.has(normalise(rest)) ? `${bullet}[x]${rest}` : line,
  );
}

/**
 * Tick every criterion the Verdict proved, wherever the Ticket writes it.
 *
 * The issue is read again rather than reusing the copy it was claimed with: a
 * whole Run has happened since, and both the body and any comment are written
 * back whole. Triage posts its brief as a comment, and nothing says all the
 * criteria are in one place, so every comment is offered the same edit.
 *
 * A criterion the Stage reworded past {@link normalise} matches nothing and is
 * left as it was, which is said out loud rather than passed over in silence: a
 * merged Ticket with an unticked criterion is otherwise a mystery.
 */
export async function tickMetCriteria(
  tracker: Tracker,
  ticket: number,
  verdict: Verdict,
  log?: (line: string) => void,
): Promise<void> {
  const met = verdict.criteria
    .filter((criterion) => criterion.status === "met")
    .map((criterion) => criterion.text);
  if (met.length === 0) return;

  const issue = await tracker.getIssue(ticket);
  let ticked = 0;

  const body = tickCriteria(issue.body, met);
  if (body !== issue.body) {
    await tracker.updateIssueBody(ticket, body);
    ticked += ticks(issue.body, body);
  }

  for (const comment of issue.comments) {
    const edited = tickCriteria(comment.body, met);
    if (edited === comment.body || comment.id === undefined) continue;
    await tracker.updateComment(comment.id, edited);
    ticked += ticks(comment.body, edited);
  }

  if (ticked < met.length) {
    log?.(
      `#${ticket} ticked ${ticked} of ${met.length} met criteria; ` +
        "the rest match no checkbox on the Ticket",
    );
  }
}

/** How many boxes an edit ticked, so a criterion that matched nothing shows up. */
function ticks(before: string, after: string): number {
  return countTicked(after) - countTicked(before);
}

function countTicked(text: string): number {
  return [...text.matchAll(/^[ \t]*[-*+] \[x\]/gm)].length;
}
