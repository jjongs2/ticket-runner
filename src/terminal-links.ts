/**
 * Ticket and pull request numbers a human can open from the terminal.
 *
 * A Run whose standard output is a terminal hands it each `#N` as an OSC 8
 * hyperlink to that issue on the Target. GitHub redirects an issue URL to the
 * pull request when the number is one, so one URL serves every number. The
 * visible text stays `#N`, so a terminal that ignores OSC 8, as ECMA-48 asks,
 * shows what it would show without it. Anywhere else, the log file an Operator
 * reads line by line included, nothing is linked.
 */

/**
 * A `#N` to link: not straight after a letter, a digit or a `/`, which is
 * another repository's number (`owner/repo#12`) or no number at all. A number
 * a trimmed `noted` row cuts short looks whole here, so the summary leaves that
 * one out itself, being the only writer that knows where it cut.
 */
const LINKABLE_NUMBER = /(?<![\p{L}\p{N}/])#(\d+)(?!\d)/gu;

/** OSC 8's opening and closing halves, each ended by the string terminator. */
const OSC8 = "\x1b]8;;";
const ST = "\x1b\\";

/**
 * `line` with every `#N` in it a link to `https://github.com/<repository>/issues/N`,
 * or `line` as it is where GitHub could not name the Target's repository.
 */
export function linkNumbers(line: string, repository: string | undefined): string {
  if (repository === undefined) return line;
  return line.replace(
    LINKABLE_NUMBER,
    (text, number: string) =>
      `${OSC8}https://github.com/${repository}/issues/${number}${ST}${text}${OSC8}${ST}`,
  );
}
