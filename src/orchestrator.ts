import { branchName, worktreePath } from "./branch.js";
import type { Config } from "./config.js";
import { tickMetCriteria } from "./criteria.js";
import { type SkipReason, isGuardReason, skipReason } from "./guards.js";
import type { FailureKind, FailurePoint } from "./lifecycle.js";
import { NOTES_JSON_SCHEMA, type RoutedNote, routeNotes } from "./notes.js";
import type {
  AgentRunner,
  StageFailure,
  StageName,
  StageResult,
} from "./ports/agent-runner.js";
import type { Issue, Tracker } from "./ports/tracker.js";
import type { Workspace } from "./ports/workspace.js";
import { Progress, type ProgressPoint, type ProgressRow } from "./progress.js";
import {
  type FixFailure,
  conflictPrompt,
  fixPrompt,
  implementPrompt,
  verifyPrompt,
} from "./prompts.js";
import {
  type ReachedState,
  type TicketState,
  clearTicketState,
  readTicketState,
  writeTicketState,
} from "./resume.js";
import { retryLogDir, stageLogDir } from "./run-log.js";
import { holdsClaim } from "./stranded.js";
import {
  draftPullRequestBody,
  guardComment,
  handoffComment,
  hasGuardWarning,
  pullRequestBody,
  squashCommit,
} from "./templates.js";
import {
  type Verdict,
  VERDICT_JSON_SCHEMA,
  countStatuses,
  parseVerdict,
  passes,
  unmetCriteria,
} from "./verdict.js";

export type TicketOutcome =
  | {
      outcome: "merged";
      ticket: number;
      /** Carried so a Run summary can name the Ticket without asking again. */
      title: string;
      branch: string;
      pullRequest: number;
      /** Every Note this Ticket's Stages routed, in the order they were routed. */
      notes: RoutedNote[];
    }
  | {
      outcome: "handed-off";
      ticket: number;
      title: string;
      branch: string;
      stage: FailurePoint;
      failure: string;
      pullRequest?: number;
      notes: RoutedNote[];
    }
  | {
      outcome: "released";
      ticket: number;
      title: string;
      branch: string;
      /** Where the rate limit landed, which is all the summary says about it. */
      stage: FailurePoint;
      notes: RoutedNote[];
    }
  | {
      outcome: "skipped";
      ticket: number;
      title: string;
      /** The guard that passed it over, in the guard's own word for it. */
      reason: SkipReason;
    };

export interface Pipeline {
  tracker: Tracker;
  runner: AgentRunner;
  workspace: Workspace;
  config: Config;
  repoRoot: string;
  runId: string;
  log?: (line: string) => void;
}

/**
 * A failure that ends the Ticket, unless the fix budget can still buy it a
 * second try. `kind` is set on exactly the failures a fix Stage is given:
 * everything else is a hand-off the moment it is thrown.
 */
class TicketFailure extends Error {
  constructor(
    readonly point: FailurePoint,
    readonly summary: string,
    readonly evidence: string = "",
    readonly kind?: FailureKind,
  ) {
    super(summary);
  }
}

/**
 * A Stage the subscription rate limit stopped.
 *
 * The one Stage failure that says nothing about the Ticket, so it is the one
 * that neither ends it nor spends its Fix budget: the Claim is released and a
 * State file is left for the next Run to resume from (ADR-0004). It is not a
 * {@link TicketFailure} because every path that handles one of those would
 * either hand the Ticket off or buy it a fix Stage, and this is neither.
 */
class RateLimited extends Error {
  constructor(
    readonly point: FailurePoint,
    /** The state the Ticket reached, which is where a later Run picks it up. */
    readonly state: ReachedState,
  ) {
    super(`the ${point} Stage hit the subscription rate limit`);
  }
}

/** An error the pipeline did not raise itself, blamed on the step it was on. */
function asTicketFailure(error: unknown, point: FailurePoint): TicketFailure {
  return error instanceof TicketFailure
    ? error
    : new TicketFailure(point, (error as Error).message);
}

/**
 * Take one Ticket from claimed to merged, hand it to a human, or pass it over.
 *
 * The happy path is: guards → claim → worktree and branch → implement Stage →
 * Checks → verify Stage → rebase → PR → CI → squash merge → cleanup. A failing
 * Check, an unmet criterion, a red CI or a rebase conflict the conflict Stage
 * could not resolve spends the Ticket's fix budget and starts again at the
 * Checks; every other failure, and every second failure, ends in a hand-off.
 * Nothing ends in a merge that has not been through a green pass of the whole
 * gauntlet.
 *
 * A Stage the subscription rate limit stopped ends none of that: the Ticket is
 * released, and a Run started once the limit has reset resumes it from the state
 * it had reached rather than from the top.
 *
 * The guards come before the claim, so an issue the pipeline will not take is
 * never marked as taken. A Run has already dropped the claimed and the
 * untriaged from its Frontier; `ticket <n>` names an issue by hand and reaches
 * those guards too.
 */
export async function processTicket(
  pipeline: Pipeline,
  ticket: number,
  /**
   * Where the Notes are collected, so a caller that has to catch an exception
   * this function could not turn into a hand-off still knows what was routed.
   * The returned outcome carries the same array.
   */
  notes: RoutedNote[] = [],
): Promise<TicketOutcome> {
  const { tracker, workspace, config, repoRoot, runId } = pipeline;
  const log = pipeline.log ?? (() => {});

  const issue = await tracker.getIssue(ticket);
  const user = await tracker.currentUser();

  // What an earlier Run left behind, read before the guards because it decides
  // one of them: a Ticket this checkout still holds with state recorded for it is
  // stranded — the Claim on it is this pipeline's own, left by a Run that never
  // came back — and the refusals must not read it as somebody else's.
  const recorded = readTicketState(repoRoot, ticket);
  const stranded = recorded !== undefined && holdsClaim(issue, user, config.labels.inProgress);
  const skip = skipReason(issue, config.labels.readyForAgent, stranded);
  if (skip !== undefined) return await passOver(pipeline, issue, skip);

  const worktree = worktreePath(repoRoot, ticket);
  // Whether the work that state names is still there. Its branch is the one the
  // work is on, which the Ticket's title may no longer say anything about.
  const resume = await resumable(pipeline, ticket, worktree, recorded);
  const branch = resume?.branch ?? branchName(ticket, issue.title);
  // Built from the comments the Ticket already has, so a Run that comes back to
  // a Ticket an earlier Run reported on edits that table rather than opening a
  // second one. Nothing is written until the first Stage finishes.
  const progress = new Progress({
    tracker,
    ticket,
    runId,
    branch,
    comments: issue.comments,
    log,
  });

  // The State file, written as part of the Claim and kept current from here on,
  // so a Run that is killed mid-Ticket still leaves the next one something to
  // resume. A resumed Ticket carries on from what it had already reached.
  //
  // First of the two, because a Claim no State file names is the one thing this
  // has to rule out: a crash between the writes then leaves a Ticket nobody has
  // claimed with state beside it, which is a released Ticket and resumes itself.
  const record = ResumeRecord.claim(pipeline, {
    ticket,
    branch,
    state: resume?.state ?? "claimed",
    fixUsed: resume?.fixUsed ?? false,
    ...(resume?.pullRequest === undefined ? {} : { pullRequest: resume.pullRequest }),
  });

  // The claim is the first write on the board: it shows what the pipeline holds
  // before anything else can go wrong. A stranded Ticket is resumed in place,
  // wearing the Claim it never gave up — re-writing what is already there would
  // only risk the Ticket on three tracker calls that change nothing.
  if (!stranded) {
    await tracker.assign(ticket, user);
    await tracker.addLabel(ticket, config.labels.inProgress);
    await tracker.removeLabel(ticket, config.labels.readyForAgent);
  }
  log(`#${ticket} ${howItWasTaken(resume, stranded)} · ${branch}`);

  // A pull request an earlier Run had already opened: without it this Run would
  // try to open a second one for the same branch.
  let pullRequest: number | undefined = resume?.pullRequest;
  // Where an unexpected error would have happened, so the hand-off comment
  // names the step the human has to look at rather than guessing.
  let point: FailurePoint = "setup";
  // The worktree a hand-off can send a human to and push out of, once there is
  // one. A Ticket that failed before `createWorktree` ran has none; a resumed
  // Ticket was resumed into the one it kept.
  let worktreeOnDisk: string | undefined = resume === undefined ? undefined : worktree;
  // The fix budget, which is one per Ticket and spent by the first failure a
  // fix Stage is offered. Once it is gone the next failure of any kind — even a
  // kind the fix Stage never touched — is a hand-off. A resumed Ticket keeps the
  // budget recorded when it stopped: resuming buys no second chances.
  let fixUsed = resume?.fixUsed ?? false;
  // The pass behind a fix Stage logs beside the first one rather than over it.
  let logDir = stageLogDir(repoRoot, runId, ticket);

  // Declared out here because ticking the Acceptance Criteria it proved happens
  // after the merge, where a failure may no longer hand the Ticket off.
  let verdict: Verdict;

  try {
    // A resumed Ticket kept its worktree and branch, and the Stages that already
    // succeeded on them are not paid for twice.
    if (resume === undefined) {
      // The branch is asked about before it is branched: `createWorktree`
      // branches fresh from main and fails on a name that is taken, and a
      // branch nobody can account for is not reused (ADR-0004). Refusing here
      // is what turns git's `fatal: a branch named ... already exists` into a
      // hand-off that says whose branch it is and what to do with it.
      if (await workspace.hasBranch(branch)) {
        // Where the branch is decides what the human is asked to do about it:
        // a hand-off keeps the worktree and the branch while clearing the State
        // file, so a Ticket relabelled after one arrives here with both still
        // there, and a branch that is checked out cannot simply be deleted.
        const checkedOutAt = (await workspace.hasWorktree({ path: worktree, branch }))
          ? worktree
          : undefined;
        // Not this Run's worktree, but the one holding the branch it was told
        // to use: the hand-off names a directory a human can open either way.
        worktreeOnDisk = checkedOutAt;
        throw new TicketFailure(
          "setup",
          describeBranchInTheWay(branch, checkedOutAt, config.labels.readyForAgent),
        );
      }
      await workspace.createWorktree({ path: worktree, branch });
      worktreeOnDisk = worktree;
    } else {
      // A Run that was killed mid-rebase left git stopped in the worktree, with
      // conflict markers in files the Checks are about to grade. Back to the
      // branch tip first, then: a no-op on a worktree nothing stopped, so every
      // resume rebases from the same clean start a released Ticket does.
      await workspace.abortRebase(worktree);
    }
    if (resume === undefined || resume.state === "claimed") {
      point = "implement";
      await implement(pipeline, issue, worktree, branch, logDir, progress, notes);
      // The branch now carries work no later Run should pay for again.
      record.advance({ state: "implemented" });
    }

    let commits: string[];
    let coAuthors: string[];
    let title: string;

    // Checks through CI, run again from the top when the fix budget buys a
    // second pass: a fix earns no shortcut, so every gate grades it afresh.
    for (;;) {
      try {
        point = "checks";
        await runChecks(pipeline, worktree, progress);
        point = "verify";
        verdict = await verify(pipeline, issue, worktree, logDir, progress);

        point = "rebase";
        const rebase = await workspace.rebaseOnMain(worktree);
        if (!rebase.ok) {
          // Once per conflict, not once per Ticket: a pass the fix budget
          // bought meets a branch the fix Stage has changed, so the conflict it
          // rebases into is a new one.
          await resolveConflict(pipeline, issue, worktree, logDir, rebase.conflict, progress);
          // The resolution is code nothing has graded: the Checks passed on one
          // side of the conflict and CI on the other. The Verdict is not asked
          // for again, because the conflict Stage is told to change no
          // behaviour the Acceptance Criteria are about.
          point = "checks";
          await runChecks(pipeline, worktree, progress);
        }

        point = "pr";
        // Read after the rebase, because these are the commits that land on main.
        commits = await workspace.commitSubjects(branch);
        coAuthors = await workspace.coAuthors(branch);
        title = pullRequestTitle(commits, issue.title);
        pullRequest = await publishPullRequest(
          pipeline,
          { issue, branch, worktree, verdict, title },
          pullRequest,
        );
        record.advance({ pullRequest });
        point = "ci";
        await requireGreenCi(pipeline, pullRequest, progress);
        break;
      } catch (error) {
        // A rate limit is nobody's defect, so the fix budget does not answer
        // for it: the Ticket is released, whole, further up.
        if (error instanceof RateLimited) throw error;
        const failure = asTicketFailure(error, point);
        if (fixUsed || failure.kind === undefined) throw failure;
        fixUsed = true;
        point = "fix";
        logDir = retryLogDir(repoRoot, runId, ticket);
        await fix(
          pipeline,
          issue,
          worktree,
          branch,
          logDir,
          { kind: failure.kind, summary: failure.summary, evidence: failure.evidence },
          progress,
          notes,
        );
        // Recorded once the Stage has come back, not when the budget was
        // committed: a fix Stage the rate limit stopped before it ran spends
        // nothing, and the release below says so.
        record.advance({ fixUsed: true });
      }
    }

    point = "merge";
    await tracker.squashMerge(
      pullRequest,
      squashCommit({ ticket, pullRequest, title, verdict, commits, coAuthors }),
    );
    await progress.record({ point: "merge", outcome: `✅ #${pullRequest}` });
  } catch (error) {
    if (error instanceof RateLimited) {
      return release(pipeline, {
        issue,
        user,
        branch,
        limit: error,
        record,
        // A fix Stage the limit stopped before it ran spends nothing: the
        // budget is still there for the Run that resumes the Ticket.
        fixUsed: fixUsed && error.point !== "fix",
        notes,
      });
    }
    return handOff(pipeline, {
      issue,
      user,
      branch,
      ...(worktreeOnDisk === undefined ? {} : { worktree: worktreeOnDisk }),
      pullRequest,
      failure: asTicketFailure(error, point),
      fixUsed,
      notes,
    });
  }

  // The Ticket is merged from here on, so nothing below may hand it off.
  // The State file goes first: a merged Ticket must not look resumable to the
  // next Run, whatever else below fails.
  try {
    clearTicketState(repoRoot, ticket);
  } catch (error) {
    log(`#${ticket} merged, but clearing its State file failed: ${(error as Error).message}`);
  }
  try {
    await tickMetCriteria(tracker, ticket, verdict, log);
  } catch (error) {
    log(`#${ticket} merged, but ticking its criteria failed: ${(error as Error).message}`);
  }
  // The merge closes the issue; the label would otherwise outlive the work.
  try {
    await tracker.removeLabel(ticket, config.labels.inProgress);
  } catch (error) {
    log(`#${ticket} merged, but clearing in-progress failed: ${(error as Error).message}`);
  }
  try {
    await workspace.pullMain();
    await workspace.removeWorktree({ path: worktree, branch });
    await workspace.deleteRemoteBranch(branch);
  } catch (error) {
    log(`#${ticket} merged, but cleaning up failed: ${(error as Error).message}`);
  }
  log(`#${ticket} merged · PR #${pullRequest}`);

  return { outcome: "merged", ticket, title: issue.title, branch, pullRequest, notes };
}

/**
 * What the human is told about a branch nothing can be branched over.
 *
 * One line, because that is what the hand-off comment, the Run summary and the
 * Run log each carry. It names the branch twice on purpose: once as the thing
 * that is in the way, and once inside the command that clears it.
 *
 * `checkedOutAt` is the worktree the branch is in, when it is in one: a branch
 * git will not let go of is not one `git branch -D` can delete, so being told
 * to run that would send the human round a second failure.
 */
function describeBranchInTheWay(
  branch: string,
  checkedOutAt: string | undefined,
  readyForAgent: string,
): string {
  const relabel = `then relabel the Ticket ${readyForAgent}`;
  if (checkedOutAt !== undefined) {
    return (
      `the branch ${branch} already exists and is checked out at ${checkedOutAt}; ` +
      `finish the work there by hand, or throw it away with ` +
      `\`git worktree remove ${checkedOutAt} && git branch -D ${branch}\`, ${relabel}`
    );
  }
  return (
    `the branch ${branch} already exists but no worktree of this repo is on it; ` +
    `delete it with \`git branch -D ${branch}\` if the work on it is abandoned, ` +
    `or finish it by hand, ${relabel}`
  );
}

/**
 * The state an earlier Run left for this Ticket, if a Run can still resume it.
 *
 * The State file only names where the work is; whether the work is still there
 * is the Workspace's answer. A human who has removed the worktree, or moved it
 * onto another branch, has thrown the resume away with it — so the file goes too
 * and the Ticket is taken from the top, released or stranded alike. That is the
 * safe reading of a worktree nobody can be sure of, not a free one: the branch
 * may still exist, and then the Ticket is handed over at setup with a failure
 * naming it. Better that than resuming into a worktree that is not there.
 */
async function resumable(
  pipeline: Pipeline,
  ticket: number,
  worktree: string,
  state: TicketState | undefined,
): Promise<TicketState | undefined> {
  if (state === undefined) return undefined;
  if (await pipeline.workspace.hasWorktree({ path: worktree, branch: state.branch })) {
    return state;
  }

  clearTicketState(pipeline.repoRoot, ticket);
  pipeline.log?.(`#${ticket} was resumable, but ${state.branch} is not in ${worktree}`);
  return undefined;
}

/**
 * How this Run came by the Ticket, for the one line it logs about it: resumed
 * from a recorded state, taken from the top, or claimed outright. A stranded
 * Ticket with nothing left to resume into is the middle one — it is started
 * again, but the Claim it is started under is the one it already had.
 */
function howItWasTaken(resume: TicketState | undefined, stranded: boolean): string {
  if (resume !== undefined) return `resumed from ${resume.state}`;
  return stranded ? "taken from the top, still claimed" : "claimed";
}

/** What the Ticket itself has reached, which is all a resume needs to be told. */
type Reached = Omit<TicketState, "runId" | "updatedAt">;

/** What one write moves that on by. */
type Advance = Partial<Pick<Reached, "state" | "fixUsed" | "pullRequest">>;

/**
 * The State file a claimed Ticket keeps, and the one place a Ticket writes it.
 *
 * A Ticket is resumable for as long as it is claimed, so the file is written as
 * part of the Claim and rewritten whenever the Ticket reaches something a later
 * Run should not pay for again. The release is one more such write rather than
 * the only one, which is what makes a Run that was killed recoverable too.
 *
 * A write that does not land is logged and nothing more. What is on disk is then
 * an earlier state of the same Ticket, and resuming from further back costs a
 * Stage rather than being wrong — where failing the Ticket over a local file
 * would throw away the work the Stages have already done.
 */
class ResumeRecord {
  /** What the Ticket has; the Run and the time are what each write adds to it. */
  private readonly reached: Reached;

  private constructor(
    private readonly pipeline: Pipeline,
    reached: Reached,
  ) {
    this.reached = { ...reached };
  }

  /**
   * Record what the Claim is about to make true, and hand back the record that
   * keeps it current.
   *
   * The one write that is allowed to fail the Ticket. It runs before the Claim,
   * so a disk that will not take the file costs nothing at all: the Ticket ends
   * at setup with nothing claimed, where carrying on would put a Claim on the
   * board that no later Run could ever resume — which is the state this record
   * exists to rule out.
   */
  static claim(pipeline: Pipeline, reached: Reached): ResumeRecord {
    const record = new ResumeRecord(pipeline, reached);
    writeTicketState(pipeline.repoRoot, record.file());
    return record;
  }

  /**
   * Move the record on, and put it where the next Run will look for it.
   *
   * A write that does not land here is logged and nothing more: what is on disk
   * is an earlier state of the same Ticket, so resuming from further back costs
   * a Stage rather than being wrong — where failing a Ticket mid-flight over a
   * local file would throw away the Stages that have already succeeded.
   */
  advance(reached: Advance): void {
    Object.assign(this.reached, reached);
    try {
      writeTicketState(this.pipeline.repoRoot, this.file());
    } catch (error) {
      this.pipeline.log?.(
        `#${this.reached.ticket} could not record its state: ${(error as Error).message}`,
      );
    }
  }

  /** The Run and the time belong to the write, not to what the Ticket reached. */
  private file(): TicketState {
    return {
      ...this.reached,
      runId: this.pipeline.runId,
      updatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Pass a candidate over, and warn about it once.
 *
 * The warning is a Planning defect a human has to fix, so it is posted at most
 * once per reason: a Run that meets the same issue again — and, for everything
 * but a Spec, the label is still there, so it will — says nothing a second
 * time. An issue that was never offered to the pipeline is refused in silence.
 */
async function passOver(
  pipeline: Pipeline,
  issue: Issue,
  reason: SkipReason,
): Promise<TicketOutcome> {
  const { tracker, config } = pipeline;

  if (isGuardReason(reason)) {
    if (!hasGuardWarning(issue.comments, reason)) {
      await tracker.comment(issue.number, guardComment(reason));
    }
    // A Spec is not a Ticket and no edit will make it one; the other two are
    // fixable in place, so their candidates keep the label and stay visible.
    if (reason === "spec") {
      await tracker.removeLabel(issue.number, config.labels.readyForAgent);
    }
  }

  pipeline.log?.(`#${issue.number} skipped · ${reason}`);
  return { outcome: "skipped", ticket: issue.number, title: issue.title, reason };
}

/**
 * Start one Stage under the model, turn and wall-clock limits its own config
 * names. Everything a Stage differs in is the prompt, where it runs and where
 * it logs; the limits come from one place so no Stage can quietly skip them.
 */
function runStage(
  pipeline: Pipeline,
  stage: StageName,
  request: {
    prompt: string;
    cwd: string;
    logDir: string;
    jsonSchema?: unknown;
    resultRequired?: boolean;
  },
): Promise<StageResult> {
  const limits = pipeline.config.stages[stage];
  return pipeline.runner.run({
    stage,
    prompt: request.prompt,
    cwd: request.cwd,
    logDir: request.logDir,
    permissionMode: pipeline.config.permissionMode,
    model: limits.model,
    maxTurns: limits.maxTurns,
    maxMinutes: limits.maxMinutes,
    ...(request.jsonSchema === undefined ? {} : { jsonSchema: request.jsonSchema }),
    ...(request.resultRequired === undefined
      ? {}
      : { resultRequired: request.resultRequired }),
  });
}

/**
 * Report a Stage the rate limit stopped, and raise the Ticket's release.
 *
 * The one place the pause is composed, because the conflict Stage reaches it by
 * another road: the row reads as a pause rather than a cross, and the error
 * carries the state a later Run resumes the Ticket from. Only the implement
 * Stage can leave a Ticket short of `implemented`; every other Stage runs on
 * work that is already on the branch.
 */
async function releasedStage(
  progress: Progress,
  stage: StageName,
  point: FailurePoint,
  result: StageResult,
): Promise<RateLimited> {
  await progress.record(stageRow(stage, result, "⏸ rate limited"));
  return new RateLimited(point, stage === "implement" ? "claimed" : "implemented");
}

/**
 * Report a Stage that did not come back, and say what it costs the Ticket.
 *
 * The rate limit is the one Stage failure the Ticket did nothing to earn, so it
 * releases the Ticket instead of ending it. Every other failure is the Stage's
 * own, and its caller decides whether the fix budget can buy another.
 */
async function stageDidNotFinish(
  pipeline: Pipeline,
  progress: Progress,
  stage: "implement" | "verify" | "fix",
  result: StageResult,
): Promise<TicketFailure | RateLimited> {
  if (result.failure === "rate-limited") {
    return await releasedStage(progress, stage, stage, result);
  }

  await progress.record(stageRow(stage, result, `❌ ${stageFailureCell(result)}`));
  return new TicketFailure(
    stage,
    describeStageFailure(stage, pipeline.config.stages[stage], result),
  );
}

/**
 * Put a Stage's Notes where they belong, before its own outcome is judged.
 *
 * Before, because a Stage that ran out of turns still noticed whatever it
 * noticed, and the Ticket it noticed it on has no idea a Run is even happening.
 * Losing the Notes would be a second cost for the same failure.
 */
async function collectNotes(
  pipeline: Pipeline,
  ticket: number,
  stage: StageName,
  result: StageResult,
  notes: RoutedNote[],
): Promise<void> {
  notes.push(
    ...(await routeNotes(
      {
        tracker: pipeline.tracker,
        origin: ticket,
        stage,
        needsTriage: pipeline.config.labels.needsTriage,
        ...(pipeline.log === undefined ? {} : { log: pipeline.log }),
      },
      result.result,
    )),
  );
}

async function implement(
  pipeline: Pipeline,
  issue: Issue,
  worktree: string,
  branch: string,
  logDir: string,
  progress: Progress,
  notes: RoutedNote[],
): Promise<void> {
  const stage = pipeline.config.stages.implement;
  const result = await runStage(pipeline, "implement", {
    prompt: implementPrompt(issue.url, stage.extraPrompt),
    cwd: worktree,
    logDir,
    jsonSchema: NOTES_JSON_SCHEMA,
    // The Notes are a side channel, not the Stage's product: a session that
    // emitted none has implemented the Ticket exactly as it always did.
    resultRequired: false,
  });
  await collectNotes(pipeline, issue.number, "implement", result, notes);
  if (!result.ok) throw await stageDidNotFinish(pipeline, progress, "implement", result);

  // An agent that gave up silently leaves a clean branch behind. That is a
  // failure, not something to verify. A resumed Ticket's branch is not clean —
  // it carries what the Stage the rate limit stopped had committed — so this
  // asks the same question there: is there anything at all to grade. Whether it
  // is enough is the Verdict's business, not this guard's.
  if ((await pipeline.workspace.commitSubjects(branch)).length === 0) {
    await progress.record(stageRow("implement", result, "❌ no commits"));
    throw new TicketFailure(
      "implement",
      "the implement Stage left no new commits on the branch",
    );
  }

  await progress.record(stageRow("implement", result, "✅ committed"));
}

async function runChecks(
  pipeline: Pipeline,
  worktree: string,
  progress: Progress,
): Promise<void> {
  // One row for the whole gate, however many commands it is made of: which
  // command failed is the outcome, and its output is the hand-off's business.
  const startedAt = Date.now();
  const minutes = pipeline.config.checkTimeoutMinutes;
  for (const command of pipeline.config.checks) {
    const result = await pipeline.workspace.runCheck(command, worktree, minutes * 60_000);
    if (!result.ok) {
      // A Check that hung and one that failed are the same failure to the fix
      // budget and the hand-off; they are told apart only in what they say, so
      // that a fix Stage knows whether it is mending a hang or an assertion.
      const timedOut = result.timedOut === true;
      await progress.record({
        point: "checks",
        outcome: `❌ \`${command}\` ${timedOut ? "timed out" : "failed"}`,
        durationMs: Date.now() - startedAt,
      });
      throw new TicketFailure(
        "checks",
        timedOut
          ? `Check \`${command}\` timed out after ${minutes} ${plural(minutes, "minute")}`
          : `Check \`${command}\` failed`,
        timedOut ? timedOutEvidence(command, result.output, minutes) : result.output,
        "failed-check",
      );
    }
  }
  await progress.record({
    point: "checks",
    outcome: "✅ passed",
    durationMs: Date.now() - startedAt,
  });
}

/**
 * What the Check printed before the kill, and then a line saying that a kill is
 * what ended it. A fix Stage is given the evidence and little else, so the
 * output alone would read as a suite that simply stopped mid-run.
 */
function timedOutEvidence(command: string, output: string, minutes: number): string {
  const trailer = `\`${command}\` was killed after ${minutes} ${plural(minutes, "minute")} at the Check wall-clock limit: it hung rather than failing, and everything above is what it had printed by then.`;
  const printed = output.trimEnd();
  return printed === "" ? trailer : `${printed}\n\n${trailer}`;
}

/** `1 minute`, `15 minutes`: the limit is a number a human reads in a sentence. */
function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

async function verify(
  pipeline: Pipeline,
  issue: Issue,
  worktree: string,
  logDir: string,
  progress: Progress,
): Promise<Verdict> {
  const stage = pipeline.config.stages.verify;
  const result = await runStage(pipeline, "verify", {
    prompt: verifyPrompt(issue.url, stage.extraPrompt),
    cwd: worktree,
    logDir,
    jsonSchema: VERDICT_JSON_SCHEMA,
  });

  // verify is allowed to write throwaway tests; none of them reach the PR.
  await pipeline.workspace.discardChanges(worktree);

  if (!result.ok) throw await stageDidNotFinish(pipeline, progress, "verify", result);

  let verdict: Verdict;
  try {
    verdict = parseVerdict(result.result);
  } catch (error) {
    await progress.record(stageRow("verify", result, "❌ no Verdict"));
    throw new TicketFailure(
      "verify",
      "the verify Stage did not return a usable Verdict",
      (error as Error).message,
    );
  }

  const counts = countStatuses(verdict);

  // The agent's own `pass` is advisory; this is the decision that counts.
  if (!passes(verdict)) {
    const unmet = unmetCriteria(verdict);
    if (unmet.length === 0) {
      await progress.record(stageRow("verify", result, "❌ no evidence"));
      throw new TicketFailure(
        "verify",
        "every criterion came back unverifiable, so there is no evidence to merge on",
        verdict.criteria.map((c) => `- ${c.text} — ${c.evidence}`).join("\n"),
      );
    }
    await progress.record(stageRow("verify", result, `❌ ${unmet.length} unmet`));
    throw new TicketFailure(
      "verify",
      `${unmet.length} of ${verdict.criteria.length} criteria unmet`,
      unmet.map((c) => `- ${c.text} — ${c.evidence}`).join("\n"),
      "unmet-criteria",
    );
  }

  const summary = `${counts.met} met · ${counts.unverifiable} unverifiable`;
  await progress.record(stageRow("verify", result, `✅ ${summary}`));
  pipeline.log?.(`#${issue.number} verified · ${summary}`);
  return verdict;
}

/**
 * What the fix budget buys: a fresh session on the same branch in the same
 * worktree, handed the failure and its evidence and nothing else to do.
 *
 * It drives no plugin skill. The implement skill would re-read the Ticket and
 * start over, where what is wanted here is one concrete defect mended.
 */
async function fix(
  pipeline: Pipeline,
  issue: Issue,
  worktree: string,
  branch: string,
  logDir: string,
  failure: FixFailure,
  progress: Progress,
  notes: RoutedNote[],
): Promise<void> {
  const stage = pipeline.config.stages.fix;
  pipeline.log?.(`#${issue.number} fixing · ${failure.summary}`);

  // Read before the Stage runs, because the implement Stage's work is already
  // on the branch: what this asks afterwards is whether the branch grew, not
  // whether it has anything on it at all.
  const commitsBefore = (await pipeline.workspace.commitSubjects(branch)).length;

  const result = await runStage(pipeline, "fix", {
    prompt: fixPrompt(issue.url, failure, stage.extraPrompt),
    cwd: worktree,
    logDir,
    jsonSchema: NOTES_JSON_SCHEMA,
    resultRequired: false,
  });
  await collectNotes(pipeline, issue.number, "fix", result, notes);
  if (!result.ok) throw await stageDidNotFinish(pipeline, progress, "fix", result);

  // A session that came back clean mended nothing, whatever it says. Believing
  // it costs the Ticket a whole second pass of the Checks, the Verdict and CI
  // over a branch nobody touched, which can only fail the way it just did — and
  // a progress row claiming the Stage committed. The budget is already spent,
  // so this ends the Ticket rather than buying another try.
  //
  // A branch that grew is the whole signal, which is not the same as one that
  // changed: a session that squashed the branch shorter, or amended in place,
  // is read here as having committed nothing.
  if ((await pipeline.workspace.commitSubjects(branch)).length <= commitsBefore) {
    await progress.record(stageRow("fix", result, "❌ no commits"));
    throw new TicketFailure("fix", "the fix Stage left no new commits on the branch");
  }

  await progress.record(stageRow("fix", result, "✅ committed"));
}

/**
 * Send one session into the stopped rebase to resolve it.
 *
 * It is not what the fix budget buys and it does not spend it: a conflict is
 * main moving on underneath a branch, not a defect in the branch, and a Ticket
 * that hits one has done nothing wrong yet. The budget covers what is left if
 * this fails.
 *
 * The tree decides whether it worked, not the session's exit status. A Stage
 * that finished the rebase and then ran out of turns has done the job; one that
 * came back clean because it quietly abandoned the rebase has not, and only the
 * worktree can tell the difference.
 *
 * A Stage the rate limit stopped is read the same way, and only then released:
 * one that had already finished the rebase leaves nothing that needs an agent
 * session, so the Ticket carries on to the Checks, the pull request and CI.
 */
async function resolveConflict(
  pipeline: Pipeline,
  issue: Issue,
  worktree: string,
  logDir: string,
  conflict: string,
  progress: Progress,
): Promise<void> {
  pipeline.log?.(`#${issue.number} resolving a rebase conflict`);

  const failure = await conflictStage(pipeline, issue, worktree, logDir, conflict, progress);
  if (failure === undefined) return;

  // Nothing may leave this function with a rebase still in the worktree, least
  // of all the fix Stage the budget may still buy: it has to have a branch to
  // commit on, and the hand-off behind it has to have one it can push.
  await pipeline.workspace.abortRebase(worktree);
  throw failure;
}

/**
 * The Stage, and what is left of the conflict once it has finished: `undefined`
 * when the worktree came back rebased.
 *
 * It returns its failure rather than throwing it so that nothing — not a Stage
 * that fell over, not git itself — can skip the abort its caller owes the
 * worktree.
 */
async function conflictStage(
  pipeline: Pipeline,
  issue: Issue,
  worktree: string,
  logDir: string,
  conflict: string,
  progress: Progress,
): Promise<TicketFailure | RateLimited | undefined> {
  const stage = pipeline.config.stages.conflict;
  try {
    const result = await runStage(pipeline, "conflict", {
      prompt: conflictPrompt(issue.url, conflict, stage.extraPrompt),
      cwd: worktree,
      logDir,
    });

    const state = await pipeline.workspace.rebaseState(worktree);
    if (state.resolved) {
      // The worktree decides the row, as it decides the outcome: a Stage that
      // ran out of turns, or into the rate limit, after finishing the rebase
      // did the job it was sent to do.
      await progress.record(stageRow("conflict", result, "✅ rebased"));
      return undefined;
    }

    // A rate limit left the conflict exactly as it found it: nothing for a fix
    // Stage to mend and nothing to blame the Ticket for. The caller still owes
    // the worktree its abort, so the branch the resumed Run rebases is clean.
    if (result.failure === "rate-limited") {
      return await releasedStage(progress, "conflict", "rebase", result);
    }

    await progress.record(stageRow("conflict", result, "❌ unresolved"));
    return new TicketFailure(
      "rebase",
      result.ok
        ? "the conflict Stage did not finish the rebase onto main"
        : describeStageFailure("conflict", stage, result),
      [conflict, state.unresolved].join("\n\n"),
      "unresolved-conflict",
    );
  } catch (error) {
    // The Stage never ran, or git could not be asked what it left behind.
    // Neither is a defect in the branch, so no fix Stage is offered for it.
    // Nothing read the worktree, so nothing here knows what the Stage left.
    await progress.record({ point: "conflict", outcome: "❌ unknown" });
    return asTicketFailure(error, "rebase");
  }
}

interface PullRequestSubject {
  issue: Issue;
  branch: string;
  worktree: string;
  verdict: Verdict;
  title: string;
}

/**
 * Push the branch, then open the pull request or bring the open one up to date.
 *
 * A second pass comes back to a pull request that already exists: the push is
 * what GitHub re-runs its checks on, and the body is rewritten so the Verdict a
 * human reads there is the one that will reach main.
 */
async function publishPullRequest(
  pipeline: Pipeline,
  { issue, branch, worktree, verdict, title }: PullRequestSubject,
  existing: number | undefined,
): Promise<number> {
  await pipeline.workspace.push(worktree, branch);
  const body = pullRequestBody({ ticket: issue.number, verdict, runId: pipeline.runId });

  if (existing !== undefined) {
    await pipeline.tracker.updatePullRequestBody(existing, body);
    return existing;
  }

  const pr = await pipeline.tracker.createPullRequest({
    head: branch,
    title,
    body,
    draft: false,
  });
  return pr.number;
}

/**
 * A red or unfinished pull request is a failure whatever the gates say. Turning
 * `gates.ci` off only tolerates a pull request that has no checks at all.
 */
async function requireGreenCi(
  pipeline: Pipeline,
  pullRequest: number,
  progress: Progress,
): Promise<void> {
  const startedAt = Date.now();
  const outcome = await pipeline.tracker.waitForCi(
    pullRequest,
    pipeline.config.ciTimeoutMinutes * 60_000,
  );
  const record = (cell: string) =>
    progress.record({ point: "ci", outcome: cell, durationMs: Date.now() - startedAt });

  switch (outcome.state) {
    case "passed":
      await record("✅ passed");
      return;
    case "failed":
      await record("❌ failed");
      // The names are the line a human reads; the log excerpt is what a fix
      // Stage works from, and it is empty whenever none could be fetched.
      throw new TicketFailure("ci", outcome.summary, outcome.excerpt, "failed-ci");
    case "timed-out":
      await record("❌ timed out");
      throw new TicketFailure(
        "ci",
        `the pull request checks did not finish within ${pipeline.config.ciTimeoutMinutes} minutes`,
      );
    case "none":
      // A gate switched off is worth a row of its own: the Ticket merged on
      // nobody's word but the pipeline's own Checks.
      await record(pipeline.config.gates.ci ? "❌ no checks" : "⚠️ no checks");
      if (!pipeline.config.gates.ci) return;
      throw new TicketFailure(
        "ci",
        "the pull request has no checks, so CI cannot gate the merge",
      );
  }
}

interface Release {
  issue: Issue;
  user: string;
  branch: string;
  limit: RateLimited;
  /** The Ticket's State file, which the release brings up to date and leaves. */
  record: ResumeRecord;
  /** Whether the Fix budget was spent by a failure of the Ticket's own. */
  fixUsed: boolean;
  notes: RoutedNote[];
}

/**
 * Release the Ticket: undo the Claim and leave a State file behind.
 *
 * The opposite of a hand-off, and deliberately quiet. Nothing about the Ticket
 * failed, nobody has to look at it, and the work already on its branch is worth
 * keeping — so the branch and the worktree stay, no comment is posted, no draft
 * pull request is opened, and the Ticket goes back on the Frontier for a Run
 * started after the limit has reset.
 */
async function release(
  pipeline: Pipeline,
  { issue, user, branch, limit, record, fixUsed, notes }: Release,
): Promise<TicketOutcome> {
  const { tracker, config } = pipeline;
  const ticket = issue.number;

  // Brought up to date before the Claim comes off: a Ticket back on the Frontier
  // whose state is out of date is one the next Run would redo Stages for.
  record.advance({ state: limit.state, fixUsed });

  // The claim, undone in the order it was made, so the assignee — which is what
  // another Run reads to tell a taken Ticket from a free one — comes off last.
  await tracker.addLabel(ticket, config.labels.readyForAgent);
  await tracker.removeLabel(ticket, config.labels.inProgress);
  await tracker.unassign(ticket, user);
  pipeline.log?.(`#${ticket} released at ${limit.point} · rate limit · ${branch}`);

  return { outcome: "released", ticket, title: issue.title, branch, stage: limit.point, notes };
}

interface HandOff {
  issue: Issue;
  user: string;
  branch: string;
  /** Where the work is, absent when the Ticket failed before it had a worktree. */
  worktree?: string;
  pullRequest: number | undefined;
  failure: TicketFailure;
  /** Whether the Ticket's fix budget had already been spent when this failure came. */
  fixUsed: boolean;
  notes: RoutedNote[];
}

/**
 * Hand the Ticket to a human: a draft PR to review, a comment naming where the
 * work is, and the labels a human filters on. The worktree and branch stay put.
 *
 * A Ticket handed over before its worktree was created has none: nothing was
 * branched, so there is no directory to name and nothing to push a draft PR out
 * of. Both are left out rather than written as a path that is not there and a
 * push that fails.
 */
async function handOff(
  pipeline: Pipeline,
  { issue, user, branch, worktree, pullRequest, failure, fixUsed, notes }: HandOff,
): Promise<TicketOutcome> {
  const { tracker, workspace, config } = pipeline;
  const ticket = issue.number;

  // The Ticket is a human's from here on, so nothing may leave it looking
  // resumable: the next Run must not pick up what somebody else is holding.
  // Wrapped because the hand-off itself — the draft PR, the comment, the labels
  // — is what a human is waiting for, and no file is worth losing it over.
  try {
    clearTicketState(pipeline.repoRoot, ticket);
  } catch (error) {
    pipeline.log?.(
      `#${ticket} handed off, but clearing its State file failed: ${(error as Error).message}`,
    );
  }

  if (pullRequest !== undefined) {
    await tracker.convertPullRequestToDraft(pullRequest);
  } else if (worktree !== undefined) {
    // A draft PR is worth trying for, but never worth losing the relabel over.
    try {
      await workspace.push(worktree, branch);
      const pr = await tracker.createPullRequest({
        head: branch,
        // Nothing here is merged, so there is no commit subject worth deriving.
        title: issue.title,
        body: draftPullRequestBody({
          ticket,
          stage: failure.point,
          failure: failure.summary,
          runId: pipeline.runId,
        }),
        draft: true,
      });
      pullRequest = pr.number;
    } catch (error) {
      pipeline.log?.(`#${ticket} could not open a draft PR: ${(error as Error).message}`);
    }
  }

  await tracker.comment(
    ticket,
    handoffComment({
      stage: failure.point,
      failure: failure.summary,
      branch,
      ...(worktree === undefined ? {} : { worktree }),
      evidence: failure.evidence,
      fixUsed,
      ...(pullRequest === undefined ? {} : { pullRequest }),
    }),
  );
  await tracker.removeLabel(ticket, config.labels.inProgress);
  await tracker.addLabel(ticket, config.labels.readyForHuman);
  await tracker.unassign(ticket, user);
  pipeline.log?.(`#${ticket} handed off at ${failure.point} · ${failure.summary}`);

  return {
    outcome: "handed-off",
    ticket,
    title: issue.title,
    branch,
    stage: failure.point,
    failure: failure.summary,
    notes,
    ...(pullRequest === undefined ? {} : { pullRequest }),
  };
}

/** Any `<type>(<scope>): <summary>`; the repo's own types and scopes are CONTRIBUTING.md's business. */
const CONVENTIONAL_SUBJECT = /^[a-z]+(\([a-z0-9._-]+\))?: \S/;

/** The `(#<n>)` a branch commit carries, which the squash commit's `Closes #<n>` replaces. */
const TICKET_REFERENCE = /\s*\(#\d+\)$/;

/**
 * The pull request title, which is also the subject of the squash commit.
 *
 * The implement Stage is told its first commit must summarise the whole Ticket
 * in the commit convention, so that subject is the one line written about the
 * branch as a whole. A subject that ignored the convention is not worth putting
 * on main, and neither is a Ticket the Stage left no commits on: the Ticket
 * title says at least as much.
 */
function pullRequestTitle(commits: string[], ticketTitle: string): string {
  const first = (commits[0] ?? "").replace(TICKET_REFERENCE, "");
  return CONVENTIONAL_SUBJECT.test(first) ? first : ticketTitle;
}

/**
 * One Stage's row, with the turns and wall-clock the runner reported.
 *
 * A Stage the runner could not put a turn count on gets no count rather than a
 * zero: nothing ran is not the same as nothing was needed.
 */
function stageRow(
  stage: ProgressPoint,
  result: StageResult,
  outcome: string,
): ProgressRow {
  return {
    point: stage,
    outcome,
    ...(result.turns === undefined ? {} : { turns: result.turns }),
    durationMs: result.durationMs,
  };
}

/** The limits a Stage was given, which are half of what its failure means. */
interface StageLimits {
  maxTurns: number;
  maxMinutes: number;
}

/**
 * Why a Stage did not finish, said twice: the words a hand-off comment reads in
 * and the two the progress table has room for. Kept in one entry per failure so
 * a new one cannot be given a sentence and left without a cell.
 */
const STAGE_FAILURES: Record<
  StageFailure,
  { cell: string; sentence: (limits: StageLimits) => string }
> = {
  "rate-limited": {
    cell: "rate limited",
    // The cell is all any path reads today: a rate-limited Stage releases the
    // Ticket rather than ending it, so no hand-off comment is written about one.
    // The sentence is kept true rather than dropped, because the table is one
    // entry per failure and the next path to need it must not have to invent it.
    sentence: () => "hit the subscription rate limit",
  },
  "timed-out": {
    cell: "timed out",
    sentence: (limits) => `ran past its ${limits.maxMinutes} minute limit`,
  },
  "turn-capped": {
    cell: "turn capped",
    sentence: (limits) => `hit its ${limits.maxTurns} turn limit`,
  },
  "nonzero-exit": { cell: "exited non-zero", sentence: () => "exited non-zero" },
  "invalid-result": {
    cell: "invalid result",
    sentence: () => "returned output its schema rejected",
  },
};

/** A Stage that came back without saying why gets the one word that is true. */
const UNEXPLAINED = { cell: "failed", sentence: () => "failed" } as const;

function stageFailure(result: StageResult) {
  return result.failure ? STAGE_FAILURES[result.failure] : UNEXPLAINED;
}

function describeStageFailure(
  stage: string,
  limits: StageLimits,
  result: StageResult,
): string {
  return `the ${stage} Stage ${stageFailure(result).sentence(limits)}`;
}

/** The same failure, short enough for a table cell. */
function stageFailureCell(result: StageResult): string {
  return stageFailure(result).cell;
}
