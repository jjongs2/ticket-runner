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
