/**
 * The colours a Run's lines take in a terminal, by what each asks of its
 * reader: red to act on a Ticket now, green for one that merged and needs
 * nothing, dim for the Run's own bookkeeping, which a reader can skip, and the
 * terminal's default for everything else, which is there to be read.
 *
 * Colour is laid over the links rather than under them: a line is linked
 * whole first ({@link linkNumbers}), and each stretch between its links is
 * coloured after, so no colour code stands before a `#N` where it would stop
 * the link rule seeing a number. Every link is bright blue at full intensity,
 * as Claude Code colours one, in a dim line too.
 *
 * Only standard output that is a terminal is coloured, and not where
 * `NO_COLOR` is set to anything (https://no-color.org): the links stay there,
 * since they are not colour. Taking every colour code out of what a Run
 * printed gives back what it prints with `NO_COLOR` set.
 */

import { linkNumbers } from "./terminal-links.js";

/** A colour a line or a verb takes; none is the terminal's default. */
export type Colour = "red" | "green" | "dim";

/**
 * What every line a Run prints on standard output is handed through: in a
 * terminal its numbers linked, and, where colour is on, painted `colour`
 * outside its links and bright blue on them. Anywhere else, the text as it is.
 */
export type Paint = (text: string, colour?: Colour) => string;

/** The {@link Paint} of standard output that is not a terminal. */
export const PLAIN: Paint = (text) => text;

const SGR: Record<Colour, string> = { red: "31", green: "32", dim: "2" };
/** Bright blue, which every link is, whatever colour the line around it takes. */
const LINK_SGR = "94";
const RESET = "\x1b[0m";

/** A whole OSC 8 link as {@link linkNumbers} writes one: opening, `#N`, closing. */
const LINK = /\x1b\]8;;[^\x1b]*\x1b\\[^\x1b]*\x1b\]8;;\x1b\\/g;

/** Every SGR sequence, which is all the colour a Run adds. */
const SGR_SEQUENCE = /\x1b\[[0-9;]*m/g;

/** Whether the Host asks for colour: `NO_COLOR` unset or empty. */
export function colourWanted(env: Record<string, string | undefined>): boolean {
  const noColor = env["NO_COLOR"];
  return noColor === undefined || noColor === "";
}

/**
 * The {@link Paint} of a terminal: numbers linked to `repository`, where
 * GitHub named one, and coloured only when `colour` is on.
 */
export function terminalPaint(repository: string | undefined, colour: boolean): Paint {
  return (text, lineColour) => {
    const linked = linkNumbers(text, repository);
    return colour ? painted(linked, lineColour) : linked;
  };
}

/** `linked` with each stretch between its links in `colour`, and each link blue. */
function painted(linked: string, colour: Colour | undefined): string {
  let out = "";
  let from = 0;
  for (const link of linked.matchAll(LINK)) {
    out += stretch(linked.slice(from, link.index), colour);
    out += `\x1b[${LINK_SGR}m${link[0]}${RESET}`;
    from = link.index + link[0].length;
  }
  return out + stretch(linked.slice(from), colour);
}

/**
 * Text between two links, in `colour`: each line of it opened and reset on its
 * own, so a line read alone, as a pager shows one, keeps its colour.
 */
function stretch(text: string, colour: Colour | undefined): string {
  if (colour === undefined) return text;
  return text
    .split("\n")
    .map((part) => (part === "" ? part : `\x1b[${SGR[colour]}m${part}${RESET}`))
    .join("\n");
}

/** `text` with every colour code a Run adds taken out, its links left. */
export function withoutColour(text: string): string {
  return text.replace(SGR_SEQUENCE, "");
}

/** The lines before the summary that ask a human to act on a Ticket now. */
const ACT_NOW = [
  /^#\d+ handed off at /,
  /^#\d+ failed outside the hand-off path/,
  /^#\d+ has a state file this version cannot use/,
];

/** The lines before the summary that report a merge, which asks nothing. */
const MERGED = [/^#\d+ merged · /];

/** The Run's own bookkeeping before the summary, which a reader can skip. */
const BOOKKEEPING = [
  /^ticket-runner \S+ run /,
  /^the clone was shallow/,
  /^#\d+ claimed$/,
  /^#\d+ resumed from /,
  /^#\d+ taken from the top/,
  /^#\d+ keeps agent\//,
  /^#\d+ noted on #/,
  /^opened #\d+ to gather Notes/,
  /^#\d+ was resumable, but /,
];

/**
 * The colour a line before the summary takes whole, read off its words; none
 * for a line to read, such as a Stage's progress or why a Ticket paused. The
 * summary colours its own rows, a verb at a time.
 */
export function lineColour(line: string): Colour | undefined {
  if (ACT_NOW.some((pattern) => pattern.test(line))) return "red";
  if (MERGED.some((pattern) => pattern.test(line))) return "green";
  if (BOOKKEEPING.some((pattern) => pattern.test(line))) return "dim";
  return undefined;
}
