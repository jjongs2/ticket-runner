/**
 * What an Acceptance Criterion looks like, for everything that reads one.
 *
 * Readers recognise a criterion by its shape and would disagree about it if each
 * carried its own pattern: the `no-criteria` guard counts one to decide a Ticket
 * is usable, the merge ticks one a Verdict proved and then counts the boxes it
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
 * The ticked twin, for the merge alone: having ticked what a Verdict proved, it
 * counts the boxes now ticked to tell whether a met criterion matched nothing.
 *
 * It shares {@link UNCHECKED_BOX}'s head so that count cannot drift from the
 * tick — a head only one of the two recognised would have the merge announce a
 * criterion matched no checkbox right after ticking its box. `[x]` only: the
 * merge writes that, and a box this misses was ticked by a human, in both the
 * before and the after of the same count.
 */
export const TICKED_BOX = String.raw`${ITEM_HEAD}\[x\]`;
