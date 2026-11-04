/**
 * Ticking the Acceptance Criteria a verdict proved.
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

import { TICKED_BOX, UNCHECKED_BOX } from "./acceptance-criteria.js";
import type { Tracker } from "./ports/tracker.js";
import type { Verdict } from "./verdict.js";

/** {@link UNCHECKED_BOX}, extended to capture the criterion text after the box. */
const CHECKBOX_LINE = new RegExp(`${UNCHECKED_BOX}( .*)$`, "gm");

/** {@link TICKED_BOX}, likewise: a line whose criterion is written, though not open. */
const TICKED_CHECKBOX_LINE = new RegExp(`${TICKED_BOX}( .*)$`, "gm");

/** {@link TICKED_BOX}, over every line of a text rather than the first. */
const TICKED_LINE = new RegExp(TICKED_BOX, "gm");

/** One parenthetical closing a criterion, with the space before it. */
const TRAILING_PARENTHETICAL = /\s*\([^()]*\)$/;

/**
 * Where the verify Stage cut a passage, with the spaces it set the cut off by:
 * a cut takes a comma or a space beside it as often as not, so `reads ... order`
 * stands for `reads, in order`.
 */
const ELLIPSIS = /\s*(?:\.\.\.|…)\s*/;

/**
 * The same criterion as the verify Stage reported it.
 *
 * The Stage is asked for the criterion verbatim and mostly obliges, but it
 * reflows and recases often enough that an exact match would leave half a
 * Ticket unticked. Whitespace and case are the differences worth forgiving on
 * every criterion; anything more and the risk is ticking a box nobody graded.
 *
 * A criterion that matches no checkbox even so gets {@link secondChancePattern},
 * and the reasons for its two forgivenesses are given there.
 */
function normalise(text: string): string {
  return text.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

/**
 * The pattern a {@link normalise}d criterion that matched no line exactly is
 * matched again with: one trailing parenthetical dropped, and each `...` or `…`
 * read as any run of characters.
 *
 * The verify Stage appends a note such as `(table)` to a criterion that ends in
 * a colon and puts its content in a block below it, and cuts passages of a long
 * criterion to an ellipsis. Both are seen in the Stage's own output, and nothing
 * else is forgiven here. Either makes a criterion looser than its whole text,
 * so the pattern ticks a line only when it picks out one.
 *
 * `undefined` when nothing but dots is left, which would match any line.
 */
function secondChancePattern(criterion: string): RegExp | undefined {
  const passages = criterion.replace(TRAILING_PARENTHETICAL, "").split(ELLIPSIS);
  if (passages.every((passage) => passage.trim() === "")) return undefined;
  return new RegExp(`^${passages.map(escapeRegExp).join(".*")}$`);
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * `texts` with every unticked box whose criterion is in `met` ticked, the texts
 * being every place one Ticket writes its criteria: its body and its comments.
 *
 * A criterion ticks every line it matches exactly, after {@link normalise}. One
 * that matches no checkbox line in any of the texts, ticked or not, is then
 * offered its {@link secondChancePattern} against the lines still unticked, all the
 * texts' together, and ticks a line only when exactly one matches. Two lines
 * that fit equally well are a guess, and a wrong tick claims a criterion was
 * graded that never was; an unticked one only says the match failed.
 *
 * Returns each text unchanged when nothing in it matched, which is how the
 * caller knows there is nothing to write back.
 */
export function tickCriteria(texts: readonly string[], met: readonly string[]): string[] {
  const wanted = new Set(met.map(normalise));
  if (wanted.size === 0) return [...texts];

  const exact = texts.map((text) => tickLines(text, (rest) => wanted.has(normalise(rest))));

  const written = new Set(
    texts.flatMap((text) =>
      [CHECKBOX_LINE, TICKED_CHECKBOX_LINE].flatMap((pattern) =>
        [...text.matchAll(pattern)].map(([, , rest = ""]) => normalise(rest)),
      ),
    ),
  );
  const missed = [...wanted].filter((criterion) => !written.has(criterion));
  if (missed.length === 0) return exact;

  const open = exact.flatMap((text, place) =>
    [...text.matchAll(CHECKBOX_LINE)].map(({ index, 2: rest = "" }) => ({
      key: lineKey(place, index),
      text: normalise(rest),
    })),
  );
  const chosen = new Set<string>();
  for (const criterion of missed) {
    const pattern = secondChancePattern(criterion);
    if (pattern === undefined) continue;
    const matches = open.filter((line) => pattern.test(line.text));
    if (matches.length === 1 && matches[0] !== undefined) chosen.add(matches[0].key);
  }
  if (chosen.size === 0) return exact;

  return exact.map((text, place) =>
    tickLines(text, (_rest, index) => chosen.has(lineKey(place, index))),
  );
}

/** `text` with each unticked box ticked whose line `tick` picks, by its criterion or offset. */
function tickLines(text: string, tick: (rest: string, index: number) => boolean): string {
  return text.replaceAll(CHECKBOX_LINE, (line, bullet: string, rest: string, index: number) =>
    tick(rest, index) ? `${bullet}[x]${rest}` : line,
  );
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
 * The body and the comments are matched together, because a criterion's second
 * chance must pick out one line on the whole Ticket, not one in each place.
 *
 * A criterion the Stage reworded past both chances matches nothing and is
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
  const [body = issue.body, ...comments] = tickCriteria(
    [issue.body, ...issue.comments.map((comment) => comment.body)],
    met,
  );
  let ticked = 0;

  if (body !== issue.body) {
    await tracker.updateIssueBody(ticket, body);
    ticked += ticks(issue.body, body);
  }

  for (const [place, comment] of issue.comments.entries()) {
    const edited = comments[place] ?? comment.body;
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
  return [...text.matchAll(TICKED_LINE)].length;
}
