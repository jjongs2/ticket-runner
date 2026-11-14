/**
 * What an Acceptance Criterion looks like, for everything that reads one.
 *
 * Readers recognise a criterion by its shape and would disagree about it if each
 * carried its own pattern: the `no-criteria` guard counts one to decide a Ticket
 * is usable, the merge ticks one a verdict proved and then counts the boxes it
 * ticked, and a Note has one escaped before it is posted. Drift between them is
 * not a cosmetic bug — a criterion the guard sees but the escaper misses lets a
 * Note read as work somebody promised, and one the merge ticks but the guard
 * never counted merges a Ticket on a checkbox nobody graded. So the line head
 * every criterion shares is written here once and every matcher derives from
 * it.
 */

/**
 * A task list item at the head of a line, up to its box: optional indent, then a
 * `-`, `*` or `+` bullet and one space. Deliberately narrow — an item anywhere
 * else on a line is prose, and widening this widens every reader at once.
 *
 * Group 1 is the indent and bullet, for the readers that rewrite a line and put
 * it back untouched. A reader that only counts lines ignores it.
 */
const ITEM_HEAD = String.raw`^([ \t]*[-*+] )`;

/**
 * An {@link ITEM_HEAD} whose box is empty: what every reader of a Ticket calls
 * an Acceptance Criterion.
 *
 * A pattern source rather than a `RegExp`, because each reader needs different
 * flags and captures around the same head.
 */
export const UNCHECKED_BOX = String.raw`${ITEM_HEAD}\[ \]`;

/**
 * The ticked twin, for the merge alone: having ticked what a verdict proved, it
 * counts the boxes now ticked to tell whether a met criterion matched nothing.
 *
 * It shares {@link UNCHECKED_BOX}'s head so that count cannot drift from the
 * tick — a head only one of the two recognised would have the merge announce a
 * criterion matched no checkbox right after ticking its box. `[x]` only: the
 * merge writes that, and a box this misses was ticked by a human, in both the
 * before and the after of the same count.
 */
export const TICKED_BOX = String.raw`${ITEM_HEAD}\[x\]`;

/** {@link UNCHECKED_BOX}, extended to capture the criterion after the box. */
const CRITERION_LINE = new RegExp(`${UNCHECKED_BOX}(.*)$`);

/** Any task list item, ticked or not, which a criterion's indented lines stop short of. */
const ANY_BOX = new RegExp(String.raw`${ITEM_HEAD}\[[ xX]\]`);

/**
 * One Acceptance Criterion as the pipeline lists it for the verify Stage, by
 * the number the verdict answers it with.
 *
 * The verdict answers a number rather than a copy of the text, so nothing ever
 * has to match a Stage's copy back to a checkbox: the copy is where the verdict
 * folded a sub-list into its line, decoded an escape or split a sentence, and
 * left a met criterion unticked.
 */
export interface ListedCriterion {
  /** Its place in the list, from 1: the body's checkboxes first, then each comment's. */
  number: number;
  /**
   * The checkbox line exactly as the Ticket wrote it when it was listed. A met
   * criterion is ticked on the unticked line that still reads so.
   */
  line: string;
  /** The criterion as its checkbox line reads after the box. */
  text: string;
  /**
   * The indented lines under the checkbox that are not checkboxes themselves,
   * as written: a sub-list or a code block that says what the line means. A
   * nested checkbox is a criterion of its own, and so are the lines under it.
   */
  details: string[];
}

/**
 * Every unticked checkbox on a Ticket, numbered in reading order: `texts` are
 * the places it writes its criteria, its body first and then its comments.
 */
export function listCriteria(texts: readonly string[]): ListedCriterion[] {
  const listed: ListedCriterion[] = [];
  for (const text of texts) {
    // A body edited on GitHub's web form ends its lines in CRLF; the line a
    // criterion is listed as is the one ticking finds, which never holds the CR.
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const match = CRITERION_LINE.exec(line);
      if (match === null) continue;
      listed.push({
        number: listed.length + 1,
        line,
        text: (match[2] ?? "").trim(),
        details: detailsUnder(lines, index),
      });
    }
  }
  return listed;
}

/**
 * The lines indented under the checkbox at `lines[at]`, up to the first line
 * that is not, leaving out any checkbox among them and the lines indented under
 * that one. A blank line inside the run is kept; blank lines at its end are not.
 */
function detailsUnder(lines: readonly string[], at: number): string[] {
  const own = indentOf(lines[at] ?? "");
  const details: string[] = [];
  /** The indent of a nested checkbox whose own lines are being passed over. */
  let nested: number | undefined;
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") {
      if (nested === undefined) details.push(line);
      continue;
    }
    const indent = indentOf(line);
    if (indent <= own) break;
    if (nested !== undefined && indent > nested) continue;
    nested = undefined;
    if (ANY_BOX.test(line)) {
      nested = indent;
      continue;
    }
    details.push(line);
  }
  while (details.length > 0 && (details.at(-1) ?? "").trim() === "") details.pop();
  return details;
}

/** How far a line is indented, a tab counting as four columns as Markdown counts it. */
function indentOf(line: string): number {
  let width = 0;
  for (const character of line) {
    if (character === " ") width += 1;
    else if (character === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}
