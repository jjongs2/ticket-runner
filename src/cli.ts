import { parseArgs } from "node:util";
import { ClaudeAgentRunner } from "./adapters/claude-agent-runner.js";
import { GhTracker } from "./adapters/gh-tracker.js";
import { GitWorkspace } from "./adapters/git-workspace.js";
import { findRepoRoot } from "./adapters/repo-root.js";
import { pipelineRepository, pipelineVersion } from "./adapters/version.js";
import { ConfigError, loadConfig } from "./config.js";
import { initTarget } from "./init.js";
import { newRunId } from "./run-log.js";
import { nestedRunRefusal } from "./stage-guard.js";
import { type Work, startRun } from "./start.js";
import { requestStop } from "./stop.js";

const USAGE = `agent-pipeline — humans plan, the pipeline executes.

Usage:
  agent-pipeline init          Set this Target up, and report what only you can.
  agent-pipeline run           Drain the Frontier, one Ticket at a time.
  agent-pipeline ticket <n>    Take one Ticket from claimed to merged.
  agent-pipeline stop          Ask the running Run to finish and take no more.

Options:
  -h, --help                   Show this message.
      --version                Show which Version this pipeline is.`;

/** What the command line comes to once it has been read: the options, and the rest. */
interface CommandLine {
  positionals: string[];
  values: { help?: boolean; version?: boolean };
}

/**
 * The command line, or nothing when it names an option this CLI does not take.
 *
 * `parseArgs` throws over one, and an uncaught throw reaches a terminal as a
 * stack trace through `node:internal` that says nothing the usage does not say
 * better. An unknown option is the mistake an unknown command is, made one
 * character earlier, so it is answered the same way and costs the same exit
 * code.
 */
function parseCommandLine(argv: string[]): CommandLine | undefined {
  try {
    return parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    console.error(`${argumentComplaint(error)}\n\n${USAGE}`);
    return undefined;
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

/**
 * Exit codes: 0 nothing handed off, 1 at least one hand-off, 2 nothing was
 * taken at all — the Run never started, or `ticket <n>` named an issue a guard
 * refused. `init` reads them as its own: 0 every reported item passed, 1 one of
 * them is the human's to put right, 2 a Stage's shell was refused. `stop` reads
 * 0 as a Stop sent and 2 as no Run there was anything to ask.
 */
async function main(argv: string[]): Promise<number> {
  // First, before the repo, the config, `gh` or even `--help`: a Stage's shell
  // may not start a Run of the pipeline it is working on.
  const nested = nestedRunRefusal(process.env);
  if (nested !== undefined) {
    console.error(nested);
    return 2;
  }

  const parsed = parseCommandLine(argv);
  if (parsed === undefined) return 2;
  const { positionals, values } = parsed;

  // Resolved once, here, and handed to everything that stamps it the way the
  // run id is: a Run whose summary, comments, State files and transcripts all
  // read it separately could report four different things (ADR-0007).
  const version = await pipelineVersion();
  // The repository a newer Version would be published on, read from the same
  // package the number came from, so a fork asks about itself (ADR-0007).
  const repository = pipelineRepository();
  if (values.version) {
    console.log(version);
    return 0;
  }

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  const [command, ...rest] = positionals;
  if (command !== "ticket" && command !== "run" && command !== "init" && command !== "stop") {
    console.error(`Unknown command \`${command}\`.\n\n${USAGE}`);
    return 2;
  }

  // Before the config and the Target's readiness, which a Stop needs none of:
  // a Run is already running, so whatever they would have refused it over was
  // answered when it started.
  if (command === "stop") {
    return requestStop({ repoRoot: await findRepoRoot() });
  }

  if (command === "init") {
    const root = await findRepoRoot();
    // No Run lock, because no Ticket is claimed, and no startup refusal: the
    // missing Checks it would refuse over are one of the things `init` reports.
    return initTarget({
      repoRoot: root,
      version,
      repository,
      config: loadConfig(root, version),
      tracker: new GhTracker({ cwd: root }),
      runner: new ClaudeAgentRunner(),
    });
  }

  let work: Work = { command: "run" };
  if (command === "ticket") {
    const ticket = Number.parseInt(rest[0] ?? "", 10);
    if (!Number.isInteger(ticket) || ticket <= 0) {
      console.error(`\`ticket\` needs an issue number.\n\n${USAGE}`);
      return 2;
    }
    work = { command: "ticket", ticket };
  }

  const repoRoot = await findRepoRoot();
  return startRun({
    work,
    repoRoot,
    config: loadConfig(repoRoot, version),
    tracker: new GhTracker({ cwd: repoRoot }),
    runner: new ClaudeAgentRunner(),
    workspace: new GitWorkspace(repoRoot),
    runId: newRunId(),
    version,
    repository,
    command: `agent-pipeline ${positionals.join(" ")}`,
  });
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 2;
}
