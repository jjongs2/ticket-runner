import { parseArgs } from "node:util";
import type { Work } from "./start.js";

/**
 * What the arguments ask for, read before anything is looked at: no repository,
 * no config, no `gh`.
 *
 * Kept out of the CLI so it can be tested — the CLI runs the moment it is
 * imported, so nothing it says can be asked of it — and so the CLI is left with
 * what it does about the answer.
 */

export const USAGE = `ticket-runner — humans plan, the pipeline executes.

It works in the GitHub repository you start it in, on the open issues
labelled \`ready-for-agent\`. For each one it has a Claude Code session
implement the issue, runs the repository's tests itself, has a second
session grade the work against the issue's acceptance criteria, opens a
pull request, and squash-merges it once CI is green. An issue it cannot
finish is left to a human, with a draft pull request and a comment.

The repository has to be set up for this first: \`init\` puts in place what
it can and reports the rest, which is yours to put right.

Usage:
  ticket-runner init          Set this repository up for the pipeline.
  ticket-runner run [<n>...]  Work through every issue that is ready, or
                              only the issues numbered <n>. The numbers say
                              which issues to take, not the order to take
                              them in: they are taken lowest number first.
  ticket-runner stop          Tell the run in progress to take no more.
  ticket-runner remove        Take the pipeline out of this repository.

Options:
  --lanes <n>                  With \`run\`: work on up to <n> issues at once,
                               whatever \`lanes\` in ticket-runner.json says.
  -y, --yes                    With \`remove\`: go ahead without asking.
  -h, --help                   Show this message.
  -v, --version                Show which version this pipeline is.`;

/**
 * What the command line comes to.
 *
 * `usage` goes to stdout, with the exit code it earned: 0 when it was asked
 * for, 2 when there was nothing else to say. `refused` goes to stderr and exits
 * 2, like every other invocation that never started.
 */
export type CommandLine =
  | { kind: "usage"; exitCode: 0 | 2 }
  | { kind: "version" }
  | { kind: "refused"; message: string }
  | { kind: "init" }
  | { kind: "stop" }
  | { kind: "remove"; yes: boolean }
  | { kind: "work"; work: Work };

/** Read the arguments after the command's own name. */
export function readCommandLine(argv: string[]): CommandLine {
  const parsed = parseCommandLine(argv);
  if (typeof parsed === "string") return refused(parsed);
  const { positionals, values } = parsed;

  if (values.version) return { kind: "version" };
  if (values.help || positionals.length === 0) {
    return { kind: "usage", exitCode: values.help ? 0 : 2 };
  }

  const [command, ...rest] = positionals;
  if (!isCommand(command)) return refused(`Unknown command \`${command}\`.`);

  // Refused rather than ignored everywhere but `run`: `init`, `stop` and
  // `remove` start nothing, so a count given to any of them is a mistake the
  // human should hear about.
  if (values.lanes !== undefined && command !== "run") {
    return refused("`--lanes` is for `run` only, which has a Frontier to share out.");
  }

  // The same for `--yes` everywhere but `remove`, the one command that asks
  // before it acts: given to any other, it answers a question nobody asks.
  if (values.yes === true && command !== "remove") {
    return refused("`--yes` is for `remove` only, the one command that asks before it acts.");
  }

  if (command === "init" || command === "stop") return { kind: command };
  if (command === "remove") return { kind: "remove", yes: values.yes === true };

  const tickets = ticketNumbers(rest);
  if (typeof tickets === "string") {
    return refused(
      `\`run\` takes Ticket numbers, each a whole number of one or more, not \`${tickets}\`.`,
    );
  }

  const lanes = values.lanes === undefined ? undefined : wholeNumber(values.lanes);
  if (values.lanes !== undefined && lanes === undefined) {
    return refused(`\`--lanes\` needs a whole number of one or more, not \`${values.lanes}\`.`);
  }
  return {
    kind: "work",
    work: {
      command: "run",
      ...(lanes === undefined ? {} : { lanes }),
      ...(tickets.length === 0 ? {} : { tickets }),
    },
  };
}

/** The commands this CLI takes, in the order the usage lists them. */
const COMMANDS = ["init", "run", "stop", "remove"] as const;

function isCommand(given: string | undefined): given is (typeof COMMANDS)[number] {
  return (COMMANDS as readonly (string | undefined)[]).includes(given);
}

/**
 * The Tickets the numbers after `run` name, ascending and each once, or the
 * first argument that is not one.
 *
 * Ascending because a Run takes the Frontier lowest number first and a
 * narrowed Run is no different: the numbers say which Tickets, and blockers say
 * which goes before which. `#12` is read as `12`, since that is how a human
 * copies a Ticket's number off GitHub.
 */
function ticketNumbers(given: string[]): number[] | string {
  const tickets = new Set<number>();
  for (const argument of given) {
    const ticket = wholeNumber(argument.startsWith("#") ? argument.slice(1) : argument);
    if (ticket === undefined) return argument;
    tickets.add(ticket);
  }
  return [...tickets].sort((first, second) => first - second);
}

/**
 * `given` as a whole number of one or more, or nothing where it is not one:
 * what a Lane count and a Ticket number both have to be.
 */
function wholeNumber(given: string): number | undefined {
  if (!/^\d+$/.test(given)) return undefined;
  const number = Number(given);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function refused(complaint: string): CommandLine {
  return { kind: "refused", message: `${complaint}\n\n${USAGE}` };
}

/** What `parseArgs` makes of the arguments: the options, and the rest. */
interface ParsedArgs {
  positionals: string[];
  values: { help?: boolean; version?: boolean; lanes?: string; yes?: boolean };
}

/**
 * The arguments, or Node's complaint about them when they name an option this
 * CLI does not take.
 *
 * `parseArgs` throws over one, and an uncaught throw reaches a terminal as a
 * stack trace through `node:internal` that says nothing the usage does not say
 * better. An unknown option is the mistake an unknown command is, made one
 * character earlier, so it is answered the same way and costs the same exit
 * code.
 */
function parseCommandLine(argv: string[]): ParsedArgs | string {
  try {
    return parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        lanes: { type: "string" },
        yes: { type: "boolean", short: "y" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    return argumentComplaint(error);
  }
}

/**
 * Node's own sentence about the argument, and only the first: it follows the
 * complaint with advice about passing a positional that starts with a `-`,
 * which no command of this CLI takes.
 */
function argumentComplaint(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const [sentence = message] = message.split(". ");
  return sentence.endsWith(".") ? sentence : `${sentence}.`;
}
