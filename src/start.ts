import { resolveBaseBranch } from "./base-branch.js";
import type { Config } from "./config.js";
import { Landing } from "./landing.js";
import { acquireLock, lockHeldMessage } from "./lock.js";
import { type Pipeline, type TicketOutcome, processTicket } from "./orchestrator.js";
import type { AgentRunner } from "./ports/agent-runner.js";
import type { Tracker } from "./ports/tracker.js";
import type { Workspace } from "./ports/workspace.js";
import { readinessRefusal } from "./readiness.js";
import { type RunStop, processRun } from "./run.js";
import { startupMessages } from "./startup.js";
import { runSummary } from "./templates.js";

/**
 * Everything between the arguments and the work: the two refusals a Run can
 * meet before it starts, the Run lock, and the summary it ends with.
 *
 * It lives here rather than in the CLI so that a refusal is provable — a test
 * drives a whole `run` against a temporary Target and a fake Tracker and asserts
 * that neither the lock nor the Frontier was ever reached. The CLI is left with
 * the arguments, the Target's root and the three adapters.
 */

/** What this invocation was asked to do, once the arguments are understood. */
export type Work = { command: "run" } | { command: "ticket"; ticket: number };

export interface StartOptions {
  work: Work;
  repoRoot: string;
  config: Config;
  tracker: Tracker;
  runner: AgentRunner;
  workspace: Workspace;
  runId: string;
  /** The command line the Run lock records, for whoever loses it. */
  command: string;
  log?: (line: string) => void;
  /** Warnings and refusals, which the CLI puts on stderr as it always has. */
  error?: (line: string) => void;
}

/**
 * Start a Run, and answer with the exit code it earned.
 *
 * Both refusals come before the lock: a Target `init` has not set up, and a
 * Target with nothing to gate a merge. Neither is a Run that went wrong, so
 * neither should leave a lock file behind for the next one to reclaim.
 */
export async function startRun(options: StartOptions): Promise<number> {
  const { repoRoot, config, tracker } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));

  const notReady = await readinessRefusal({ repoRoot, labels: config.labels, tracker });
  if (notReady !== undefined) {
    error(notReady);
    return 2;
  }

  const { refusal, warnings } = startupMessages(config);
  for (const warning of warnings) error(`warning: ${warning}`);
  if (refusal !== undefined) {
    error(refusal);
    return 2;
  }

  // Taken before the first write, so two Runs never both claim a Ticket.
  const lock = acquireLock(repoRoot, {
    pid: process.pid,
    command: options.command,
    runId: options.runId,
    startedAt: new Date().toISOString(),
  });
  if (!lock.ok) {
    error(lockHeldMessage(lock.holder, repoRoot));
    return 2;
  }

  try {
    return await execute(options, log);
  } finally {
    lock.release();
  }
}

async function execute(options: StartOptions, log: (line: string) => void): Promise<number> {
  const { work, repoRoot, config, tracker, runner, workspace, runId } = options;

  // Once per Run, before any Ticket: every branch, rebase, pull request and
  // pull of this Run goes to the branch this answers.
  const baseBranch = await resolveBaseBranch(tracker, config);

  const pipeline: Pipeline = {
    tracker,
    runner,
    workspace,
    config,
    repoRoot,
    runId,
    baseBranch,
    // Once per Run as well, and for the same reason: the Tickets of one Run
    // take turns between their rebase and their merge, and a Landing made per
    // Ticket would be a queue of one every time (ADR-0005).
    landing: new Landing(),
    log,
  };

  const startedAt = Date.now();
  log(`agent-pipeline run ${runId}${work.command === "run" ? "" : ` · #${work.ticket}`}`);
  const summary = (outcomes: TicketOutcome[], stop?: RunStop) =>
    runSummary({
      runId,
      durationMs: Date.now() - startedAt,
      outcomes,
      ...(stop === undefined ? {} : { stop }),
    });

  if (work.command === "run") {
    const { outcomes, stop } = await processRun(pipeline);
    log(`\n${summary(outcomes, stop)}`);
    return exitCode(outcomes);
  }

  // `ticket <n>` drains no Frontier, so its summary does not claim one.
  const outcome = await processTicket(pipeline, work.ticket);
  log(`\n${summary([outcome])}`);
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
