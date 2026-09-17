import { parseArgs } from "node:util";
import { ClaudeAgentRunner } from "./adapters/claude-agent-runner.js";
import { execOrThrow } from "./adapters/exec.js";
import { GhTracker } from "./adapters/gh-tracker.js";
import { GitWorkspace } from "./adapters/git-workspace.js";
import { ConfigError, loadConfig } from "./config.js";
import { ensureLabels } from "./labels.js";
import { acquireLock, lockHeldMessage } from "./lock.js";
import type { Pipeline, TicketOutcome } from "./orchestrator.js";
import { processTicket } from "./orchestrator.js";
import { newRunId } from "./run-log.js";
import type { RunResult } from "./run.js";
import { processRun } from "./run.js";
import { startupMessages } from "./startup.js";
import { runSummary } from "./templates.js";

const USAGE = `agent-pipeline — humans plan, the pipeline executes.

Usage:
  agent-pipeline run           Drain the Frontier, one Ticket at a time.
  agent-pipeline ticket <n>    Take one Ticket from claimed to merged.

Options:
  -h, --help                   Show this message.`;

/** Exit codes: 0 nothing handed off, 1 at least one hand-off, 2 the Run never started. */
async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: { help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  const [command, ...rest] = positionals;
  if (command !== "ticket" && command !== "run") {
    console.error(`Unknown command \`${command}\`.\n\n${USAGE}`);
    return 2;
  }

  let ticket: number | undefined;
  if (command === "ticket") {
    ticket = Number.parseInt(rest[0] ?? "", 10);
    if (!Number.isInteger(ticket) || ticket <= 0) {
      console.error(`\`ticket\` needs an issue number.\n\n${USAGE}`);
      return 2;
    }
  }

  const repoRoot = await findRepoRoot();
  const config = loadConfig(repoRoot);

  const { refusal, warnings } = startupMessages(config);
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  if (refusal !== undefined) {
    console.error(refusal);
    return 2;
  }

  const runId = newRunId();
  // Taken before the first write, so two Runs never both claim a Ticket.
  const lock = acquireLock(repoRoot, {
    pid: process.pid,
    command: `agent-pipeline ${positionals.join(" ")}`,
    runId,
    startedAt: new Date().toISOString(),
  });
  if (!lock.ok) {
    console.error(lockHeldMessage(lock.holder, repoRoot));
    return 2;
  }

  try {
    return await execute({ command, ticket, repoRoot, config, runId });
  } finally {
    lock.release();
  }
}

interface Execution {
  command: "run" | "ticket";
  ticket: number | undefined;
  repoRoot: string;
  config: ReturnType<typeof loadConfig>;
  runId: string;
}

async function execute({
  command,
  ticket,
  repoRoot,
  config,
  runId,
}: Execution): Promise<number> {
  const tracker = new GhTracker({ cwd: repoRoot });
  const created = await ensureLabels(tracker, config.labels);
  if (created.length > 0) console.log(`Created labels: ${created.join(", ")}`);

  const pipeline: Pipeline = {
    tracker,
    runner: new ClaudeAgentRunner(),
    workspace: new GitWorkspace(repoRoot),
    config,
    repoRoot,
    runId,
    log: (line) => console.log(line),
  };

  const startedAt = Date.now();
  console.log(
    `agent-pipeline run ${runId}${ticket === undefined ? "" : ` · #${ticket}`}`,
  );

  // `ticket <n>` never computes a Frontier, so its summary does not claim one.
  const result: RunResult | { outcomes: TicketOutcome[] } =
    command === "run"
      ? await processRun(pipeline)
      : { outcomes: [await processTicket(pipeline, ticket as number)] };

  console.log(
    `\n${runSummary({ runId, durationMs: Date.now() - startedAt, ...result })}`,
  );
  return result.outcomes.some((outcome) => outcome.outcome === "handed-off") ? 1 : 0;
}

async function findRepoRoot(): Promise<string> {
  const { stdout } = await execOrThrow("git", ["rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 2;
}
