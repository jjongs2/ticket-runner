/**
 * The end of what a command printed, cut to fit where the pipeline quotes it.
 *
 * A CI log goes to a fix Stage and into a hand-off comment, and a failing Base
 * branch's output goes into a Note on the standing Notes issue. Both have to
 * stay readable, and a comment has to stay under what GitHub accepts, so both
 * quote the same tail.
 */

/** Lines kept from the tail. */
export const MAX_TAIL_LINES = 40;

/** Characters kept from the tail, for lines long enough to need it. */
export const MAX_TAIL_CHARS = 4_000;

/**
 * The end of a log, under a fixed cap, saying what it left out.
 *
 * The tail is the part worth carrying: a runner prints the assertion or the
 * stack that ended the job last, under however much setup noise came first.
 */
export function logTail(log: string): string {
  const lines = log.split("\n");
  let kept = lines.slice(-MAX_TAIL_LINES);
  while (kept.length > 1 && kept.join("\n").length > MAX_TAIL_CHARS) kept = kept.slice(1);

  const text = kept.join("\n");
  const omitted = lines.length - kept.length;

  // A single line longer than the whole cap keeps its own tail: the error is at
  // the end of it. Its own start is cut too, which the count alone would not say.
  if (text.length > MAX_TAIL_CHARS) {
    const earlier = omitted > 0 ? `${omitted} earlier lines and the start of this one` : "the start of this line";
    return `… (${earlier} omitted)\n${text.slice(-MAX_TAIL_CHARS)}`;
  }
  return omitted > 0 ? `… (${omitted} earlier lines omitted)\n${text}` : text;
}
