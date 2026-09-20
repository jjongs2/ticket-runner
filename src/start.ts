import { resolveBaseBranch } from "./base-branch.js";
import type { Config } from "./config.js";
import { Landing } from "./landing.js";
import { acquireLock, lockHeldMessage } from "./lock.js";
import { type Pipeline, type TicketOutcome, processTicket } from "./orchestrator.js";
import type { AgentRunner } from "./ports/agent-runner.js";
import type { Tracker } from "./ports/tracker.js";
import type { Workspace } from "./ports/workspace.js";
import { readinessRefusal } from "./readiness.js";
import { writeRunVersion } from "./run-log.js";
import { type RunStop, processRun } from "./run.js";
import { type StopSource, StopSignal, listenForStop, stopLine } from "./stop.js";
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
  /**
   * The Version this Run is, resolved once in the CLI (ADR-0007). Everything
   * the Run stamps takes it from here, so every stamp says the same thing.
   */
  version: string;
  /** The command line the Run lock records, for whoever loses it. */
  command: string;
  log?: (line: string) => void;
  /** Warnings and refusals, which the CLI puts on stderr as it always has. */
  error?: (line: string) => void;
  /** Where SIGTERM comes from. The process itself, unless a test is watching. */
  signals?: StopSource;
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

  // Listened for only while the lock is held, because the lock is what names
  // the process a human sends SIGTERM to, and only a Run holding Tickets has
  // anything to finish. Stopped again in the same breath as the lock: a signal
  // handler holds the event loop open, so a Run still listening would print its
  // summary and never exit.
  const stopping = new StopSignal();
  const deafen = listenForStop(stopping, options.signals);
  try {
    return await execute(options, log, stopping);
  } finally {
    // The lock goes first: SIGTERM between the two is a kill again, and a kill
    // that leaves the lock behind costs the next Run a stale holder to reclaim,
    // where one that leaves the Stop unread costs nothing at all.
    try {
      lock.release();
    } finally {
      deafen();
    }
  }
}

async function execute(
  options: StartOptions,
  log: (line: string) => void,
  stopping: StopSignal,
): Promise<number> {
  const { work, repoRoot, config, tracker, runner, workspace, runId, version } = options;

  // Before the first Stage, and before the tracker is asked anything: a
  // transcript has to sit beside the pipeline that wrote it, and the Run
  // summary that says the same thing is a terminal these files outlive.
  // Logged and nothing more when it fails — a directory that will not take a
  // one-line file is no reason to take no Ticket at all.
  try {
    writeRunVersion(repoRoot, runId, version);
  } catch (error) {
    log(`could not record the Version beside the transcripts: ${(error as Error).message}`);
  }

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
    version,
    baseBranch,
    // Once per Run as well, and for the same reason: the Tickets of one Run
    // take turns between their rebase and their merge, and a Landing made per
    // Ticket would be a queue of one every time (ADR-0005).
    landing: new Landing(),
    log,
  };

  const startedAt = Date.now();
  log(opening(runId, work, config.lanes));
  const summary = (outcomes: TicketOutcome[], stop?: RunStop) =>
    runSummary({
      version,
      runId,
      durationMs: Date.now() - startedAt,
      outcomes,
      ...(stop === undefined ? {} : { stop }),
    });

  if (work.command === "run") {
    const { outcomes, stop } = await processRun(pipeline, stopping);
    log(`\n${summary(outcomes, stop)}`);
    return exitCode(outcomes);
  }

  // `ticket <n>` takes the one Ticket it was given whatever happens, so a Stop
  // asks it for nothing but to finish — which is what listening for the signal
  // at all already bought. The line still goes out: a human who asked for a
  // Stop is owed an answer, and the Ticket in flight is what the answer is.
  stopping.watch(() => log(stopLine([work.ticket])));

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
 * The line a Run opens with, and the only place the Lane count is said out loud.
 *
 * Everything after it that is about a Ticket starts with that Ticket's number,
 * so a transcript of interleaved Lanes can be read one Ticket at a time; the
 * lines about the Run itself — this one, and the summary — carry no number.
 *
 * `ticket <n>` names its Ticket instead. It takes the one Ticket it was given
 * whatever the config says, so a Lane count there would describe a Frontier it
 * never drains.
 */
function opening(runId: string, work: Work, lanes: number): string {
  const subject =
    work.command === "run"
      ? `${lanes} ${lanes === 1 ? "lane" : "lanes"}`
      : `#${work.ticket}`;
  return `agent-pipeline run ${runId} · ${subject}`;
}

/**
 * A hand-off is what the exit code reports, because it is the one outcome that
 * asks a human for something. A Run that took nothing is a 0, and so is one
 * that released what it took: the rate limit resets and a later Run resumes it.
 */
function exitCode(outcomes: TicketOutcome[]): number {
  return outcomes.some((outcome) => outcome.outcome === "handed-off") ? 1 : 0;
}
