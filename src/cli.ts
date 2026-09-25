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

It works in the GitHub repository you start it in, on the open issues
labelled \`ready-for-agent\`. For each one it has a Claude Code session
implement the issue, runs the repository's tests itself, has a second
session grade the work against the issue's acceptance criteria, opens a
pull request, and squash-merges it once CI is green. An issue it cannot
finish is left to a human, with a draft pull request and a comment.

The repository has to be set up for this first: \`init\` puts in place what
it can and reports the rest, which is yours to put right.

Usage:
  agent-pipeline init          Set this repository up for the pipeline.
  agent-pipeline run           Work through every issue that is ready.
  agent-pipeline ticket <n>    Work through issue <n> and nothing else.
  agent-pipeline stop          Tell the run in progress to take no more.

Options:
  -h, --help                   Show this message.
  -v, --version                Show which version this pipeline is.`;

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
        version: { type: "boolean", short: "v" },
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
    const root = await findRepoRoot();
    return await requestStop({ repoRoot: root, workspace: new GitWorkspace(root) });
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
  const config = loadConfig(repoRoot, version);
  return startRun({
    work,
    repoRoot,
    config,
    // The one setting an adapter holds rather than being handed per call: the
    // CI wait's grace is the tracker's own, so the Target's minutes reach it here.
    tracker: new GhTracker({
      cwd: repoRoot,
      checksGraceMs: config.ciGraceMinutes * 60_000,
    }),
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
