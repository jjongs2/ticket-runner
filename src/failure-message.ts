/**
 * An error message as the pipeline shows it.
 *
 * A failure the pipeline did not expect reaches it as an error whose message
 * is a command, how it exited, and then whatever the command printed:
 * `throwOnFailure` in `adapters/exec.ts` builds it so, and nothing about how
 * it is built changes here. What changes is how it is shown. Wherever one line
 * is expected — a hand-off's `Failure:` line, a draft pull request's opening,
 * a Run summary's row, a console log line — the command and how it exited
 * go, as one line, and the output goes where the whole of it can be read. No
 * line of the output is picked as the reason: a rule that picked one would
 * name the wrong cause on an output nobody has seen yet, and the output is
 * never dropped.
 */

/** A message's one line, and the output that followed it. */
export interface SplitMessage {
  /**
   * The command and how it exited, from the first line that says anything,
   * with the lines of an argument that ran over several elided.
   */
  line: string;
  /** Everything after it, trimmed; empty when the message is one line. */
  output: string;
}

export function splitMessage(message: string): SplitMessage {
  const lines = message.split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1) return { line: "", output: "" };
  const last = commandEnd(lines, first);
  // A command whose arguments ran over several lines — a pull request's body,
  // a comment's — is given by its first line and its last, which closes it
  // and says how it exited. The lines between are what the pipeline itself
  // wrote, not what the command printed, so they are neither line nor output.
  const line =
    last === first ? lines[first]!.trim() : `${lines[first]!.trim()} … ${lines[last]!.trim()}`;
  return {
    line,
    output: lines
      .slice(last + 1)
      .join("\n")
      .trim(),
  };
}

/** The end of a quoted command and how it exited: `` …` exited 1 ``. */
const EXITED = /` exited -?\d+$/;

/**
 * The line a message's command ends on: its first, unless that line opens a
 * quoted command it does not close and a later line closes it with how it
 * exited. `throwOnFailure` joins the arguments as they are, so an argument
 * with a newline in it carries the command onto the lines after.
 */
function commandEnd(lines: string[], first: number): number {
  const opening = lines[first]!.trim();
  const opensCommand = (opening.match(/`/g) ?? []).length % 2 === 1;
  if (!opensCommand || EXITED.test(opening)) return first;
  const end = lines.findIndex((line, index) => index > first && EXITED.test(line.trim()));
  return end === -1 ? first : end;
}

/**
 * What a log line whose output was already printed in this Run says in place
 * of printing it again.
 */
const SAME_OUTPUT = "the same output as above";

/**
 * The Run's console log, printing each failure's output once.
 *
 * One cause tends to fail several steps of a Ticket in turn — a remote that
 * refuses SSH fails the push, the draft pull request, the transcripts and the
 * pull the rebase starts with — and each event logs the same output. Printed
 * nine times it buries the lines that matter, so a line whose output this log
 * has already printed gives its one line and says the output is the same.
 * A line with no output passes as it is.
 */
export function printEachOutputOnce(print: (line: string) => void): (line: string) => void {
  const printed = new Set<string>();
  return (text) => {
    const { line, output } = splitMessage(text);
    if (output === "") return print(text);
    if (printed.has(output)) return print(`${line} · ${SAME_OUTPUT}`);
    printed.add(output);
    print(text);
  };
}

/**
 * A quoted message ended as a sentence, so that a sentence can follow it.
 *
 * A command's output often ends with its own full stop, and one appended after
 * it reads as a typo: "…and the repository exists.. It still names this Run".
 */
export function endSentence(message: string): string {
  const trimmed = message.trimEnd();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
