/**
 * An error message as the pipeline shows it.
 *
 * A failure the pipeline did not expect reaches it as an error whose message
 * is a command and how it exited, on its first line, and then whatever the
 * command printed: `throwOnFailure` in `adapters/exec.ts` builds it so, giving
 * an argument with a newline in it by its first line alone. Wherever one line
 * is expected — a hand-off's `Failure:` line, a draft pull request's opening,
 * a Run summary's row, a console log line — the first line goes, and the
 * output goes where the whole of it can be read. No line of the output is
 * picked as the reason: a rule that picked one would name the wrong cause on
 * an output nobody has seen yet, and the output is never dropped.
 */

/** A message's one line, and the output that followed it. */
export interface SplitMessage {
  /** The first line that says anything: the command and how it exited. */
  line: string;
  /** Everything after it, trimmed; empty when the message is one line. */
  output: string;
}

export function splitMessage(message: string): SplitMessage {
  const lines = message.split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1) return { line: "", output: "" };
  return {
    line: lines[first]!.trim(),
    output: lines
      .slice(first + 1)
      .join("\n")
      .trim(),
  };
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
