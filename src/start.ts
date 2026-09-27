import { resolveBaseBranch } from "./base-branch.js";
import type { Config } from "./config.js";
import { hostKind } from "./host.js";
import { Landing } from "./landing.js";
import { StandingNotes } from "./notes.js";
import { lockHeldMessage, unreleasedLockMessage } from "./lock.js";
import type { Pipeline, TicketOutcome } from "./orchestrator.js";
import type { AgentRunner } from "./ports/agent-runner.js";
import type { Tracker } from "./ports/tracker.js";
import type { Workspace } from "./ports/workspace.js";
import { readinessRefusal } from "./readiness.js";
import { LOCAL_STATE_DIR, localStateTickets } from "./resume.js";
import { writeRunVersion } from "./run-log.js";
import { type RunStop, processRun } from "./run.js";
import { conventionsWarning, newerVersionLine } from "./staleness.js";
import { type StopSource, StopSignal, listenForStop } from "./stop.js";
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

/**
 * What this invocation was asked to do, once the arguments are understood.
 *
 * A Run may be told how many Lanes it has, which wins over the Target's config
 * because how many Tickets a Host can carry at once is the Host's business, not
 * the Target's (ADR-0008). It may also be narrowed to the Tickets a human
 * named, ascending and each once; with none it drains the whole Frontier.
 */
export interface Work {
  command: "run";
  lanes?: number;
  tickets?: number[];
}

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
  /**
   * The pipeline's own repository, as `owner/name`, which the newer-Version
   * notice is looked up against; see {@link import("./staleness.js")}.
   */
  repository?: string | undefined;
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
 * Every refusal comes before the lock: a Target `init` has not set up, one
 * holding State files an earlier pipeline left in the checkout, and one with
 * nothing to gate a merge. None is a Run that went wrong, so none should leave
 * a lock behind for the next one to reclaim.
 */
export async function startRun(given: StartOptions): Promise<number> {
  // The count a Run was told is folded into the config once, here, so
  // nothing downstream has two Lane counts to choose between.
  const { lanes } = given.work;
  const options =
    lanes === undefined ? given : { ...given, config: { ...given.config, lanes } };
  const { repoRoot, config, tracker, workspace } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));

  const notReady = await readinessRefusal({ repoRoot, labels: config.labels, tracker });
  if (notReady !== undefined) {
    error(notReady);
    return 2;
  }

  const leftBehind = localStateTickets(repoRoot);
  if (leftBehind.length > 0) {
    error(localStateMessage(leftBehind));
    return 2;
  }

  const { refusal, warnings } = startupMessages(config);
  // Which Version the document names is a warning and never a refusal, so it
  // joins the config's own: readiness has already refused a copy naming none,
  // and one naming another Version is nothing a Run is worse for (ADR-0007).
  const stale = conventionsWarning(repoRoot, options.version);
  for (const warning of [...warnings, ...(stale === undefined ? [] : [stale])]) {
    error(`warning: ${warning}`);
  }
  if (refusal !== undefined) {
    error(refusal);
    return 2;
  }

  // Taken before the first write, so two Runs never both claim a Ticket, and
  // on the Target's remote, so that holds whichever Host each Run is on.
  const claim = {
    pid: process.pid,
    command: options.command,
    runId: options.runId,
    startedAt: new Date().toISOString(),
  };
  const found = await workspace.takeRunLock(claim);
  // A lock whose Run on this Host has gone is taken over: the alternative is a
  // Run ended by Ctrl+C blocking the Target until a human releases a lock they
  // have never heard of. One held from another Host is never abandoned, and
  // waits for that human.
  const lock = found.outcome === "abandoned" ? await workspace.takeOverRunLock(claim) : found;
  if (lock.outcome === "held") {
    error(lockHeldMessage(lock));
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
      await workspace.releaseRunLock();
    } catch (failure) {
      // Reported, and the Run's own exit code kept: every Ticket it took has
      // already ended, and the lock left behind is the one thing to tell.
      error(unreleasedLockMessage(failure instanceof Error ? failure.message : String(failure)));
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

  // Asked once, and said twice: at the top of the log a human watches, and
  // again at the head of the summary they scroll back to hours later.
  const newer = await newerVersionLine({
    tracker,
    version,
    repository: options.repository,
  });

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
    host: hostKind(process.env),
    baseBranch,
    // Once per Run as well, and for the same reason: the Tickets of one Run
    // take turns between their rebase and their merge, and a Landing made per
    // Ticket would be a queue of one every time (ADR-0005).
    landing: new Landing(),
    // Once per Run as well: the Notes of every Ticket the night takes land on
    // one issue, and the Run looks it up once however many it writes.
    standingNotes: new StandingNotes(),
    log,
  };

  const startedAt = Date.now();
  log(opening(runId, work, config.lanes));
  if (newer !== undefined) log(newer);
  const summary = (outcomes: TicketOutcome[], stop: RunStop) =>
    runSummary({
      version,
      runId,
      durationMs: Date.now() - startedAt,
      outcomes,
      ...(newer === undefined ? {} : { newer }),
      stop,
    });

  const { outcomes, stop } = await processRun(pipeline, stopping, work.tickets);
  log(`\n${summary(outcomes, stop)}`);
  return exitCode(outcomes, work.tickets !== undefined);
}

/**
 * Why a Run will not start over State files a pipeline before the state branch
 * left in the checkout, and what the human does about it.
 *
 * Each is a Ticket that pipeline could resume and this one cannot see, since
 * resume state lives on the Target's remote now and nothing migrates it
 * (ADR-0004). A Run that went ahead would take a released one from the top, over
 * the branch it left, and never sweep a stranded one at all.
 */
function localStateMessage(tickets: number[]): string {
  const named = tickets.map((ticket) => `#${ticket}`).join(", ");
  return (
    `${LOCAL_STATE_DIR} holds State files for ${named}, which this Version no longer reads: ` +
    "a Ticket's resume state lives on the Target's remote now. Finish those Tickets with " +
    `the Version that wrote the files, or hand them to a human, then delete ${LOCAL_STATE_DIR} ` +
    "and run again."
  );
}

/**
 * The line a Run opens with, and the only place the Lane count is said out loud.
 *
 * Everything after it that is about a Ticket starts with that Ticket's number,
 * so a transcript of interleaved Lanes can be read one Ticket at a time; the
 * lines about the Run itself — this one, and the summary — carry no number.
 *
 * A narrowed Run names the Tickets it was given after its Lanes, ascending,
 * which is also the order it takes the ones the Frontier offers in.
 */
function opening(runId: string, work: Work, lanes: number): string {
  const subject = [
    `${lanes} ${lanes === 1 ? "lane" : "lanes"}`,
    ...(work.tickets === undefined ? [] : [work.tickets.map((ticket) => `#${ticket}`).join(" ")]),
  ];
  return `ticket-runner run ${runId} · ${subject.join(" · ")}`;
}

/**
 * A hand-off is what the exit code reports first, because it is the one outcome
 * that asks a human for something. A released Ticket was taken all the same:
 * the rate limit resets and a later Run resumes it.
 *
 * A narrowed Run that took none of the Tickets it was given — every one
 * skipped, blocked, or a mix — took nothing at all, which is the same nothing a
 * lock or a bad argument reports. A Run that was not narrowed and skipped every
 * candidate still exits 0: draining a Frontier of unusable Tickets is the job,
 * not a failure to do it.
 */
function exitCode(outcomes: TicketOutcome[], narrowed: boolean): number {
  if (outcomes.some((outcome) => outcome.outcome === "handed-off")) return 1;
  if (narrowed && outcomes.every((outcome) => outcome.outcome === "skipped")) return 2;
  return 0;
}
