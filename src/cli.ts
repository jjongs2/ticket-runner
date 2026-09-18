import { parseArgs } from "node:util";
import { ClaudeAgentRunner } from "./adapters/claude-agent-runner.js";
import { GhTracker } from "./adapters/gh-tracker.js";
import { GitWorkspace } from "./adapters/git-workspace.js";
import { findRepoRoot } from "./adapters/repo-root.js";
import { resolveBaseBranch } from "./base-branch.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { ensureLabels } from "./labels.js";
import { acquireLock, lockHeldMessage } from "./lock.js";
import type { Pipeline, TicketOutcome } from "./orchestrator.js";
import { processTicket } from "./orchestrator.js";
import { newRunId } from "./run-log.js";
import { type RunStop, processRun } from "./run.js";
import { nestedRunRefusal } from "./stage-guard.js";
import { startupMessages } from "./startup.js";
import { runSummary } from "./templates.js";

const USAGE = `agent-pipeline — humans plan, the pipeline executes.

Usage:
  agent-pipeline run           Drain the Frontier, one Ticket at a time.
  agent-pipeline ticket <n>    Take one Ticket from claimed to merged.

Options:
  -h, --help                   Show this message.`;

/**
 * Exit codes: 0 nothing handed off, 1 at least one hand-off, 2 nothing was
 * taken at all — the Run never started, or `ticket <n>` named an issue a guard
 * refused.
 */
async function main(argv: string[]): Promise<number> {
  // First, before the repo, the config, `gh` or even `--help`: a Stage's shell
  // may not start a Run of the pipeline it is working on.
  const nested = nestedRunRefusal(process.env);
  if (nested !== undefined) {
    console.error(nested);
    return 2;
  }

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
    return await execute(work, { repoRoot, config, runId });
  } finally {
    lock.release();
  }
}

/** What this invocation was asked to do, once the arguments are understood. */
type Work = { command: "run" } | { command: "ticket"; ticket: number };

interface Setup {
  repoRoot: string;
  config: Config;
  runId: string;
}

async function execute(work: Work, { repoRoot, config, runId }: Setup): Promise<number> {
  const tracker = new GhTracker({ cwd: repoRoot });
  const created = await ensureLabels(tracker, config.labels);
  if (created.length > 0) console.log(`Created labels: ${created.join(", ")}`);
  // Once per Run, before any Ticket: every branch, rebase, pull request and
  // pull of this Run goes to the branch this answers.
  const baseBranch = await resolveBaseBranch(tracker, config);

  const pipeline: Pipeline = {
    tracker,
    runner: new ClaudeAgentRunner(),
    workspace: new GitWorkspace(repoRoot),
    config,
    repoRoot,
    runId,
    baseBranch,
    log: (line) => console.log(line),
  };

  const startedAt = Date.now();
  console.log(
    `agent-pipeline run ${runId}${work.command === "run" ? "" : ` · #${work.ticket}`} · ${baseBranch}`,
  );
  const summary = (outcomes: TicketOutcome[], stop?: RunStop) =>
    runSummary({
      runId,
      durationMs: Date.now() - startedAt,
      outcomes,
      ...(stop === undefined ? {} : { stop }),
    });

  if (work.command === "run") {
    const { outcomes, stop } = await processRun(pipeline);
    console.log(`\n${summary(outcomes, stop)}`);
    return exitCode(outcomes);
  }

  // `ticket <n>` drains no Frontier, so its summary does not claim one.
  const outcome = await processTicket(pipeline, work.ticket);
  console.log(`\n${summary([outcome])}`);
  // A guard that refused the named issue leaves the invocation with nothing
  // taken, which is the same nothing a lock or a bad argument reports. A `run`
  // that skipped every candidate still exits 0: draining a Frontier of
  // unusable Tickets is the job, not a failure to do it.
  if (outcome.outcome === "skipped") return 2;
  return exitCode([outcome]);
}

/**
 * A hand-off is what the exit code reports, because it is the one outcome that
 * asks a human for something. A Run that took nothing is a 0, and so is one
 * that released what it took: the rate limit resets and a later Run resumes it.
 */
function exitCode(outcomes: TicketOutcome[]): number {
  return outcomes.some((outcome) => outcome.outcome === "handed-off") ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 2;
}
