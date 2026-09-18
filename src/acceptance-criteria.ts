/**
 * What an Acceptance Criterion looks like, for everything that reads one.
 *
 * Three readers recognise a criterion by its shape and would disagree about it
 * if each carried its own pattern: the `no-criteria` guard counts one to decide
 * a Ticket is usable, the merge ticks one a Verdict proved, and a Note has one
 * escaped before it is posted. Drift between them is not a cosmetic bug — a
 * criterion the guard sees but the escaper misses lets a Note read as work
 * somebody promised, and one the merge ticks but the guard never counted merges
 * a Ticket on a checkbox nobody graded. So the shape is written here once and
 * the three derive their matchers from it.
 */

/**
 * An unticked task list item at the head of a line: optional indent, a `-`, `*`
 * or `+` bullet, and an empty box. Deliberately narrow — a box anywhere else on
 * a line is prose, and widening this widens all three readers at once.
 *
 * A pattern source rather than a `RegExp`, because each reader needs different
 * flags and captures around the same head. Group 1 is the indent and bullet,
 * which the readers that rewrite a line put back untouched.
 */
export const UNCHECKED_BOX = String.raw`^([ \t]*[-*+] )\[ \]`;
