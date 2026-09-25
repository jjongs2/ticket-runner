import { branchName, worktreePath } from "./branch.js";
import type { Config } from "./config.js";
import { tickMetCriteria } from "./criteria.js";
import { type SkipReason, isGuardReason, skipReason } from "./guards.js";
import { markHandoffsTaken } from "./handoff.js";
import type { HostKind } from "./host.js";
import type { Landing, LandingTurn } from "./landing.js";
import type { FailureKind, FailurePoint } from "./lifecycle.js";
import {
  NOTES_JSON_SCHEMA,
  type NotingStage,
  type RoutedNote,
  type StandingNotes,
  type StandingNotesLookup,
  routeNotes,
} from "./notes.js";
import type {
  AgentRunner,
  StageFailure,
  StageName,
  StageResult,
} from "./ports/agent-runner.js";
import type { Issue, Tracker } from "./ports/tracker.js";
import type {
  KeptTranscripts,
  ReachedState,
  TicketState,
  Workspace,
  WorktreeFromRemote,
} from "./ports/workspace.js";
import { Progress, type ProgressPoint, type ProgressRow } from "./progress.js";
import {
  type FixFailure,
  conflictPrompt,
  fixPrompt,
  implementPrompt,
  verifyPrompt,
} from "./prompts.js";
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
  /**
   * The Version this Run is, resolved once in the CLI and stamped on everything
   * the Run writes (ADR-0007). A string, never a lookup: nothing here reads
   * `package.json` or runs git, so every stamp of one Run is the same string.
   */
  version: string;
  /**
   * The Host the Run is on, which decides whether a merged pull request's body
   * can point at the Run's directory: a cloud Host's is gone with its session.
   */
  host: HostKind;
  /**
   * The branch every Ticket of this Run branches from, rebases onto, merges
   * into and pulls, resolved once before the Run started
   * ({@link import("./base-branch.js").resolveBaseBranch}).
   */
  baseBranch: string;
  /**
   * The Run's Landing, made once before the first Ticket and shared by every
   * Ticket it drives: only one of them is between its rebase and the pull of
   * the Base branch after its merge at a time (ADR-0005).
   */
  landing: Landing;
  /**
   * The Run's standing Notes issue, resolved once and shared by every Ticket:
   * the Notes of a whole night land on one issue, and the Stages that write
   * them are told which one it is.
   */
  standingNotes: StandingNotes;
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
 * Checks → verify Stage → rebase → PR → CI → squash merge → cleanup. Work left
 * uncommitted, a failing Check, an unmet criterion, a red CI or a rebase
 * conflict the conflict Stage could not resolve spends the Ticket's fix budget
 * and starts again at the Checks; every other failure, and every second
 * failure, ends in a hand-off.
 * Nothing ends in a merge that has not been through a green pass of the whole
 * gauntlet.
 *
 * A Stage the subscription rate limit stopped ends none of that: the Ticket is
 * released, and a Run started once the limit has reset resumes it from the state
 * it had reached rather than from the top. A hand-off keeps that state too, so a
 * human who relabels the Ticket `ready-for-agent` hands it back and the next Run
 * carries on from what it reached rather than paying for the implement Stage a
 * second time.
 *
 * The guards come before the claim, so an issue the pipeline will not take is
 * never marked as taken. A Run has already dropped the claimed and the
 * untriaged from its Frontier; `ticket <n>` names an issue by hand and reaches
 * those guards too.
 *
 * From the pull of the Base branch before the rebase to the pull after the
 * merge the Ticket holds the Run's Landing, so no other Ticket of the same Run moves the Base
 * branch underneath the branch CI is grading (ADR-0005).
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
  // Made here rather than where it is first entered, so that however the Ticket
  // ends — including on a path nobody wrote a hand-off for — the Landing is
  // given back. Every path that leaves it early says so where it happens; this
  // is only the backstop behind them.
  const turn = pipeline.landing.turn();
  try {
    return await takeTicket(pipeline, ticket, turn, notes);
  } finally {
    turn.leave();
  }
}

/** One Ticket, holding the turn at the Landing its caller owes the Run. */
async function takeTicket(
  pipeline: Pipeline,
  ticket: number,
  landing: LandingTurn,
  notes: RoutedNote[],
): Promise<TicketOutcome> {
  const { tracker, workspace, config, repoRoot, runId, baseBranch } = pipeline;
  const log = pipeline.log ?? (() => {});

  const issue = await tracker.getIssue(ticket);
  const user = await tracker.currentUser();

  // What an earlier Run left behind, read before the guards because it decides
  // one of them: a Ticket this pipeline still holds with state recorded for it is
  // stranded — the Claim on it is this pipeline's own, left by a Run that never
  // came back — and the refusals must not read it as somebody else's.
  const recorded = await workspace.readState(ticket);
  const stranded = recorded !== undefined && holdsClaim(issue, user, config.labels.inProgress);
  const skip = skipReason(issue, config.labels.readyForAgent, stranded);
  if (skip !== undefined) return await passOver(pipeline, issue, skip);

  const worktree = worktreePath(repoRoot, ticket);
  // Whether the work that state names is still there, on this Host or the
  // remote. Its branch is the one the work is on, which the Ticket's title may
  // no longer say anything about.
  const found = await resumable(pipeline, ticket, worktree, recorded);
  const resume = found?.state;
  const branch = resume?.branch ?? branchName(ticket, issue.title);
  // Built from the comments the Ticket already has, so a Run that comes back to
  // a Ticket an earlier Run reported on adds its section to that comment rather
  // than opening a second one. Nothing is written until the first Stage finishes.
  const progress = new Progress({
    tracker,
    ticket,
    version: pipeline.version,
    runId,
    branch,
    comments: issue.comments,
    log,
  });

  // The State file, written as part of the Claim and kept current from here on,
  // so a Run that is killed mid-Ticket — or a human handed the Ticket — still
  // leaves the next Run something to resume. A resumed Ticket carries on from
  // what it had already reached.
  //
  // First of the two, because a Claim no State file names is the one thing this
  // has to rule out: a crash between the writes then leaves a Ticket nobody has
  // claimed with state beside it, which is a released Ticket and resumes itself.
  const record = await ResumeRecord.claim(pipeline, {
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

  // Whatever hand-off left this Ticket to a human is no longer the last word on
  // it. Marked here because the comments are already in hand, and because one
  // place covers both endings: the Ticket that merges from here, and the one
  // that is handed off a second time below a hand-off that has been defused.
  await markHandoffsTaken({ tracker, ticket, comments: issue.comments, log });

  // A pull request an earlier Run had already opened: without it this Run would
  // try to open a second one for the same branch.
  let pullRequest: number | undefined = resume?.pullRequest;
  // Where an unexpected error would have happened, so the hand-off comment
  // names the step the human has to look at rather than guessing.
  let point: FailurePoint = "setup";
  // The worktree a hand-off can send a human to, once there is one, and whether
  // this Run may push out of it. A Ticket that failed before `createWorktree`
  // ran has none; a resumed Ticket is resumed into the one this Host kept, or
  // made from its remote branch.
  let worktreeOnDisk: HandOffWorktree | undefined =
    resume === undefined ? undefined : { path: worktree, pushable: true };
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
    // A resumed Ticket's worktree is ready by now, and the Stages that already
    // succeeded on its branch are not paid for twice.
    if (found?.refusal !== undefined) {
      // Nothing is pushed out of a worktree this Run cannot resume in, since
      // what the remote holds may be another Host's newer work.
      worktreeOnDisk =
        found.checkedOutAt === undefined
          ? undefined
          : { path: found.checkedOutAt, pushable: false };
      throw new TicketFailure("setup", found.refusal);
    }
    if (resume === undefined) {
      // The branch is asked about before it is branched: `createWorktree`
      // branches fresh from the base branch and fails on a name that is taken,
      // and a branch nobody can account for is not reused (ADR-0004). Refusing
      // here is what turns git's `fatal: a branch named ... already exists`
      // into a hand-off that says whose branch it is and what to do with it.
      if (await workspace.hasBranch(branch)) {
        // Where the branch is decides what the human is asked to do about it:
        // a branch that is checked out cannot simply be deleted, so the human
        // is sent to the worktree holding it instead. Nothing the pipeline left
        // is here — a Ticket it handed off keeps its State file and resumes
        // without ever reaching this — so the branch is a human's either way.
        const checkedOutAt = (await workspace.hasWorktree({ path: worktree, branch }))
          ? worktree
          : undefined;
        // Not this Run's worktree, but the one holding the branch it was told
        // to use: the hand-off names a directory a human can open either way,
        // and pushes nothing out of work no Stage of this Run produced.
        worktreeOnDisk =
          checkedOutAt === undefined ? undefined : { path: checkedOutAt, pushable: false };
        throw new TicketFailure(
          "setup",
          describeBranchInTheWay(branch, checkedOutAt, config.labels.readyForAgent),
        );
      }
      await workspace.createWorktree({ path: worktree, branch }, baseBranch);
      worktreeOnDisk = { path: worktree, pushable: true };
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
      await record.advance({ state: "implemented" });
    }

    let commits: string[];
    let coAuthors: string[];
    let title: string;

    // Checks through CI, run again from the top when the fix budget buys a
    // second pass: a fix earns no shortcut, so every gate grades it afresh.
    for (;;) {
      try {
        point = "checks";
        // Before anything grades the worktree, and so before verify discards
        // what a Stage left uncommitted.
        await requireCommitted(pipeline, worktree, progress);
        await runChecks(pipeline, worktree, progress);
        point = "verify";
        verdict = await verify(pipeline, issue, worktree, logDir, progress, notes);

        point = "rebase";
        // The Landing, from here until the Base branch has been pulled: the
        // Ticket waits its turn, and the Base branch it rebases onto is then
        // the one its merge will land on.
        await landing.enter();
        // Up to the remote first: a Base branch the checkout holds behind it
        // is a rebase that changes nothing and a pull request that conflicts,
        // which GitHub then runs no CI for. One that cannot be brought up is a
        // failure here, since rebasing onto it would be the same mistake.
        await workspace.pullBase(baseBranch);
        const rebase = await workspace.rebase(worktree, baseBranch);
        if (!rebase.ok) {
          // Once per conflict, not once per Ticket: a pass the fix budget
          // bought meets a branch the fix Stage has changed, so the conflict it
          // rebases into is a new one.
          await resolveConflict(
            pipeline,
            issue,
            worktree,
            branch,
            logDir,
            rebase.conflict,
            progress,
          );
          // The resolution is code nothing has graded: the Checks passed on one
          // side of the conflict and CI on the other. The Verdict is not asked
          // for again, because the conflict Stage is told to change no
          // behaviour the Acceptance Criteria are about.
          point = "checks";
          await runChecks(pipeline, worktree, progress);
        }

        point = "pr";
        // Read after the rebase, because these are the commits that land on
        // the base branch.
        commits = await workspace.commitSubjects(branch, baseBranch);
        coAuthors = await workspace.coAuthors(branch, baseBranch);
        title = pullRequestTitle(commits, issue.title);
        pullRequest = await publishPullRequest(
          pipeline,
          { issue, branch, worktree, verdict, title },
          pullRequest,
        );
        await record.advance({ pullRequest });
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
        // A fix Stage is a session nobody else is waiting on, so the Landing
        // goes back: another Ticket lands while it runs, and this one rejoins
        // the queue at the back when it reaches the rebase again.
        landing.leave();
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
        await record.advance({ fixUsed: true });
      }
    }

    point = "merge";
    await tracker.squashMerge(
      pullRequest,
      squashCommit({ ticket, pullRequest, title, verdict, commits, coAuthors }),
    );
    await progress.record({ point: "merge", outcome: `✅ #${pullRequest}` });
  } catch (error) {
    // Out of the Landing before either ending is written: a hand-off's draft
    // pull request and a Release's labels are nothing for the next Ticket to
    // wait behind, and a Ticket that never reached the rebase gives up nothing.
    landing.leave();
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
      // A resume refused at setup keeps it too: the work is the pipeline's,
      // and whichever side a human keeps is one a later Run resumes from.
      keepsState: found?.refusal !== undefined || worktreeOnDisk?.pushable === true,
      pullRequest,
      failure: asTicketFailure(error, point),
      fixUsed,
      record,
      notes,
    });
  }

  // The Ticket is merged from here on, so nothing below may hand it off, and
  // it is still in the Landing: the pull below is the last of it.
  // The State file goes first: a merged Ticket must not look resumable to the
  // next Run, whatever else below fails — which is worth the Landing staying
  // shut for three writes nobody else is waiting on.
  try {
    await workspace.removeState(ticket);
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
    await workspace.pullBase(baseBranch);
    // The pull ends the Landing: the next Ticket now rebases onto a Base branch
    // that already carries this one, and the cleanup below holds nobody up.
    landing.leave();
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

/** A Ticket a Run can resume, and whether it can carry on in its worktree. */
interface Resumable {
  state: TicketState;
  /**
   * Why it cannot, when it cannot: this Host's copy of the branch has parted
   * from the remote one, or the worktree could not be made ready at all.
   * Either is a hand-off at setup, and the State stays.
   */
  refusal?: string;
  /** The worktree the branch is checked out in, for a refusal to send a human to. */
  checkedOutAt?: string;
}

/**
 * The state an earlier Run left for this Ticket, if a Run can still resume it,
 * with the worktree it resumes in made ready.
 *
 * The State file only names where the work is; where the work actually is, is
 * the Workspace's answer, and the branch on the remote is what it answers from
 * (ADR-0004). Any Host's Run pushes it each time a Stage commits, so a Host
 * with no worktree of the Ticket makes one from it, and one that still has a
 * worktree keeps it only when it sits on top of the remote branch.
 *
 * Taken from the top, and the file with it, only when the branch is on neither
 * this Host nor the remote: there is no work left to resume, released or
 * stranded alike. That is not free: the branch may still be here without its
 * worktree, and then the Ticket is handed over at setup with a failure naming
 * it. Better that than resuming into a worktree that is not there.
 */
async function resumable(
  pipeline: Pipeline,
  ticket: number,
  worktree: string,
  state: TicketState | undefined,
): Promise<Resumable | undefined> {
  if (state === undefined) return undefined;
  const ref = { path: worktree, branch: state.branch };
  // Caught here, because nothing is claimed yet: the refusal is raised once the
  // Claim is made, as a hand-off a human can see on the board.
  let found: WorktreeFromRemote;
  let checkedOut: boolean;
  try {
    found = await pipeline.workspace.worktreeFromRemote(ref);
    checkedOut = found === "parted" && (await pipeline.workspace.hasWorktree(ref));
  } catch (error) {
    return {
      state,
      refusal: `the worktree of ${state.branch} could not be made ready to resume in: ${(error as Error).message}`,
    };
  }
  if (found === "made" || found === "kept") return { state };
  if (found === "parted") {
    const checkedOutAt = checkedOut ? worktree : undefined;
    return {
      state,
      refusal: describeParted(state.branch, checkedOutAt, pipeline.config.labels.readyForAgent),
      ...(checkedOutAt === undefined ? {} : { checkedOutAt }),
    };
  }

  pipeline.log?.(
    `#${ticket} was resumable, but ${state.branch} is neither in ${worktree} nor on the remote`,
  );
  // Logged and nothing more when it fails: the Claim writes this Ticket's State
  // over it in a moment, from the top.
  try {
    await pipeline.workspace.removeState(ticket);
  } catch (error) {
    pipeline.log?.(`#${ticket} could not forget its state: ${(error as Error).message}`);
  }
  return undefined;
}

/**
 * What the human is told about a branch whose copy here has parted from the
 * one on the remote: which two copies, and the two ways to make them one.
 *
 * One line, as for {@link describeBranchInTheWay}. `checkedOutAt` is the
 * worktree the branch is in, when it is in one.
 */
function describeParted(
  branch: string,
  checkedOutAt: string | undefined,
  readyForAgent: string,
): string {
  const here =
    checkedOutAt === undefined
      ? `the branch ${branch} on this Host`
      : `the worktree at ${checkedOutAt}`;
  const discard =
    checkedOutAt === undefined
      ? `\`git branch -D ${branch}\``
      : `\`git worktree remove ${checkedOutAt} && git branch -D ${branch}\``;
  return (
    `${here} and the branch ${branch} on the remote have parted, each holding commits ` +
    `the other lacks; keep the remote's by throwing this Host's away with ${discard}, ` +
    `or force-push this Host's over it by hand, then relabel the Ticket ${readyForAgent}`
  );
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
 * The State file a Ticket keeps, and the one place a Ticket writes it.
 *
 * A Ticket is resumable for as long as its branch carries work worth resuming,
 * so the file is written as part of the Claim and rewritten whenever the Ticket
 * reaches something a later Run should not pay for again. The release is one
 * more such write rather than the only one, which is what makes a Run that was
 * killed recoverable too, and the hand-off is another.
 *
 * A write that does not land is logged and nothing more. What the remote holds
 * is then an earlier state of the same Ticket, and resuming from further back
 * costs a Stage rather than being wrong — where failing the Ticket over its
 * bookkeeping would throw away the work the Stages have already done.
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
   * so a remote that will not take the file costs nothing at all: the Ticket ends
   * at setup with nothing claimed, where carrying on would put a Claim on the
   * board that no later Run could ever resume — which is the state this record
   * exists to rule out.
   */
  static async claim(pipeline: Pipeline, reached: Reached): Promise<ResumeRecord> {
    const record = new ResumeRecord(pipeline, reached);
    await pipeline.workspace.writeState(record.file());
    return record;
  }

  /**
   * Move the record on, and put it where the next Run will look for it.
   *
   * A write that does not land here is logged and nothing more: what the remote
   * holds is an earlier state of the same Ticket, so resuming from further back
   * costs a Stage rather than being wrong — where failing a Ticket mid-flight
   * over its bookkeeping would throw away the Stages that have already succeeded.
   */
  async advance(reached: Advance): Promise<void> {
    Object.assign(this.reached, reached);
    try {
      await this.pipeline.workspace.writeState(this.file());
    } catch (error) {
      this.pipeline.log?.(
        `#${this.reached.ticket} could not record its state: ${(error as Error).message}`,
      );
    }
  }

  /**
   * The Run, the Version and the time belong to the write, not to what the
   * Ticket reached: they say which pipeline left the file, so a Run that cannot
   * read one can still name what wrote it (ADR-0007).
   */
  private file(): TicketState {
    return {
      ...this.reached,
      runId: this.pipeline.runId,
      version: this.pipeline.version,
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
 * Start one Stage under the model, effort, turn and wall-clock limits its own
 * config names. Everything a Stage differs in is the prompt, where it runs and
 * where it logs; the limits come from one place so no Stage can quietly skip them.
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
    effort: limits.effort,
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
  stage: NotingStage,
  result: StageResult,
  notes: RoutedNote[],
): Promise<void> {
  notes.push(
    ...(await routeNotes(
      {
        ...standingNotesLookup(pipeline),
        origin: ticket,
        stage,
        inProgress: pipeline.config.labels.inProgress,
        standing: pipeline.standingNotes,
      },
      result.result,
    )),
  );
}

/** What the Run's standing Notes issue is found — and opened — with. */
function standingNotesLookup(pipeline: Pipeline): StandingNotesLookup {
  return {
    tracker: pipeline.tracker,
    needsTriage: pipeline.config.labels.needsTriage,
    ...(pipeline.log === undefined ? {} : { log: pipeline.log }),
  };
}

/**
 * The standing Notes issue's number for a Stage's prompt, or nothing when none
 * is open yet.
 *
 * Asked before the Stage rather than after it, because what it buys is a Stage
 * that reads what has already been reported before it writes a Note of its own.
 * Nothing is opened for it: an issue is opened when a Note needs one.
 */
async function standingNotesNumber(pipeline: Pipeline): Promise<number | undefined> {
  return await pipeline.standingNotes.current(standingNotesLookup(pipeline));
}

/**
 * How many commits the branch carries that the base branch does not, which is
 * how both code Stages are asked whether they committed anything.
 */
async function commitCount(pipeline: Pipeline, branch: string): Promise<number> {
  const subjects = await pipeline.workspace.commitSubjects(branch, pipeline.baseBranch);
  return subjects.length;
}

/**
 * Push the branch a Stage has just committed on, so the work outlives the Host
 * it was done on and a Run on any Host resumes from it (ADR-0004).
 *
 * A push that does not land is logged and nothing more, as a State write that
 * does not land is: the remote then holds an earlier tip of the same work, and
 * resuming from further back costs a Stage rather than being wrong. The push
 * the pull request needs is a different one, and fails the Ticket where it is.
 */
async function pushCommitted(
  pipeline: Pipeline,
  ticket: number,
  worktree: string,
  branch: string,
): Promise<void> {
  try {
    await pipeline.workspace.push(worktree, branch);
  } catch (error) {
    pipeline.log?.(`#${ticket} could not push ${branch}: ${(error as Error).message}`);
  }
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
    prompt: implementPrompt(
      issue.url,
      pipeline.baseBranch,
      stage.extraPrompt,
      await standingNotesNumber(pipeline),
    ),
    cwd: worktree,
    logDir,
    jsonSchema: NOTES_JSON_SCHEMA,
    // The Notes are a side channel, not the Stage's product: a session that
    // emitted none has implemented the Ticket exactly as it always did.
    resultRequired: false,
  });
  await collectNotes(pipeline, issue.number, "implement", result, notes);

  // Pushed whatever became of the Stage, like its Notes: a session that
  // committed and then ran into the rate limit still committed, and the Host
  // that resumes the Ticket may be another one.
  const commits = await commitCount(pipeline, branch);
  if (commits > 0) await pushCommitted(pipeline, issue.number, worktree, branch);
  if (!result.ok) throw await stageDidNotFinish(pipeline, progress, "implement", result);

  // An agent that gave up silently leaves a clean branch behind. That is a
  // failure, not something to verify. A resumed Ticket's branch is not clean —
  // it carries what the Stage the rate limit stopped had committed — so this
  // asks the same question there: is there anything at all to grade. Whether it
  // is enough is the Verdict's business, not this guard's.
  if (commits === 0) {
    await progress.record(stageRow("implement", result, "❌ no commits"));
    throw new TicketFailure(
      "implement",
      "the implement Stage left no new commits on the branch",
    );
  }

  await progress.record(stageRow("implement", result, "✅ committed"));
}

/**
 * Refuse a worktree holding changes no commit carries, naming every path.
 *
 * Nothing is discarded here: a fix Stage sent in for it decides what belongs
 * to the Ticket, and a hand-off leaves the changes where a human can find them.
 * The summary names no Stage, because a resumed Ticket cannot say which one
 * left them: a fix Stage the rate limit stopped spent no budget.
 */
async function requireCommitted(
  pipeline: Pipeline,
  worktree: string,
  progress: Progress,
): Promise<void> {
  const paths = await pipeline.workspace.uncommittedPaths(worktree);
  if (paths.length === 0) return;

  await progress.record({ point: "checks", outcome: "❌ uncommitted work" });
  throw new TicketFailure(
    "checks",
    "the worktree holds changes no commit carries",
    paths.join("\n"),
    "uncommitted-work",
  );
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
      await progress.record({
        point: "checks",
        outcome: `❌ \`${command}\` ${result.timedOut ? "timed out" : "failed"}`,
        durationMs: Date.now() - startedAt,
      });
      throw new TicketFailure(
        "checks",
        `Check \`${command}\` ${result.timedOut ? "timed out" : "failed"}`,
        result.timedOut ? killedEvidence(command, result.output, minutes) : result.output,
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
function killedEvidence(command: string, output: string, minutes: number): string {
  const unit = minutes === 1 ? "minute" : "minutes";
  const trailer = `\`${command}\` was killed after ${minutes} ${unit} at the Check wall-clock limit: it hung rather than failing, and everything above is what it had printed by then.`;
  const printed = output.trimEnd();
  return printed === "" ? trailer : `${printed}\n\n${trailer}`;
}

async function verify(
  pipeline: Pipeline,
  issue: Issue,
  worktree: string,
  logDir: string,
  progress: Progress,
  notes: RoutedNote[],
): Promise<Verdict> {
  const stage = pipeline.config.stages.verify;
  const result = await runStage(pipeline, "verify", {
    prompt: verifyPrompt(issue.url, stage.extraPrompt, await standingNotesNumber(pipeline)),
    cwd: worktree,
    logDir,
    jsonSchema: VERDICT_JSON_SCHEMA,
  });

  // Before anything else is done with the Stage at all, as the code Stages do
  // it: a session that ran out of turns, or came back with a Verdict nothing
  // can be made of, still noticed whatever it noticed. The scratch work it
  // noticed it in is about to be discarded, so its Notes are all that is left —
  // and a worktree that will not discard them is no reason to lose them too.
  await collectNotes(pipeline, issue.number, "verify", result, notes);

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
  const commitsBefore = await commitCount(pipeline, branch);

  const result = await runStage(pipeline, "fix", {
    prompt: fixPrompt(
      issue.url,
      failure,
      pipeline.baseBranch,
      stage.extraPrompt,
      await standingNotesNumber(pipeline),
    ),
    cwd: worktree,
    logDir,
    jsonSchema: NOTES_JSON_SCHEMA,
    resultRequired: false,
  });
  await collectNotes(pipeline, issue.number, "fix", result, notes);

  // Pushed whatever became of the Stage, as the implement Stage's work is.
  const grew = (await commitCount(pipeline, branch)) > commitsBefore;
  if (grew) await pushCommitted(pipeline, issue.number, worktree, branch);
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
  if (!grew) {
    await progress.record(stageRow("fix", result, "❌ no commits"));
    throw new TicketFailure("fix", "the fix Stage left no new commits on the branch");
  }

  await progress.record(stageRow("fix", result, "✅ committed"));
}

/**
 * Send one session into the stopped rebase to resolve it.
 *
 * It is not what the fix budget buys and it does not spend it: a conflict is
 * the base branch moving on underneath a branch, not a defect in the branch,
 * and a Ticket that hits one has done nothing wrong yet. The budget covers what
 * is left if this fails.
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
  branch: string,
  logDir: string,
  conflict: string,
  progress: Progress,
): Promise<void> {
  pipeline.log?.(`#${issue.number} resolving a rebase conflict`);

  const failure = await conflictStage(
    pipeline,
    issue,
    worktree,
    branch,
    logDir,
    conflict,
    progress,
  );
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
  branch: string,
  logDir: string,
  conflict: string,
  progress: Progress,
): Promise<TicketFailure | RateLimited | undefined> {
  const stage = pipeline.config.stages.conflict;
  try {
    const result = await runStage(pipeline, "conflict", {
      prompt: conflictPrompt(issue.url, conflict, pipeline.baseBranch, stage.extraPrompt),
      cwd: worktree,
      logDir,
    });

    const state = await pipeline.workspace.rebaseState(worktree, pipeline.baseBranch);
    if (state.resolved) {
      // The worktree decides the row, as it decides the outcome: a Stage that
      // ran out of turns, or into the rate limit, after finishing the rebase
      // did the job it was sent to do.
      await progress.record(stageRow("conflict", result, "✅ rebased"));
      // The rebase rewrote the branch, and the resolution is a commit of the
      // Stage's like any other.
      await pushCommitted(pipeline, issue.number, worktree, branch);
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
        ? `the conflict Stage did not finish the rebase onto ${pipeline.baseBranch}`
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
 * human reads there is the one that will reach the base branch.
 *
 * One that already exists is also taken out of draft, because a Ticket resumed
 * after a hand-off comes back to the pull request the hand-off drafted and a
 * draft cannot be merged. Here rather than at the merge: a draft pull request
 * often runs no workflows at all, so the wait for CI below would read it as
 * "no checks" and end the Ticket before the merge was ever asked for.
 */
async function publishPullRequest(
  pipeline: Pipeline,
  { issue, branch, worktree, verdict, title }: PullRequestSubject,
  existing: number | undefined,
): Promise<number> {
  await pipeline.workspace.push(worktree, branch);
  const body = pullRequestBody({
    ticket: issue.number,
    verdict,
    runId: pipeline.runId,
    host: pipeline.host,
  });

  if (existing !== undefined) {
    await pipeline.tracker.updatePullRequestBody(existing, body);
    await pipeline.tracker.markPullRequestReady(existing);
    return existing;
  }

  const pr = await pipeline.tracker.createPullRequest({
    base: pipeline.baseBranch,
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
  await record.advance({ state: limit.state, fixUsed });

  // The claim, undone in the order it was made, so the assignee — which is what
  // another Run reads to tell a taken Ticket from a free one — comes off last.
  await tracker.addLabel(ticket, config.labels.readyForAgent);
  await tracker.removeLabel(ticket, config.labels.inProgress);
  await tracker.unassign(ticket, user);
  pipeline.log?.(`#${ticket} released at ${limit.point} · rate limit · ${branch}`);

  return { outcome: "released", ticket, title: issue.title, branch, stage: limit.point, notes };
}

/** The worktree a hand-off has to hand, which is not always one of this Run's. */
interface HandOffWorktree {
  /** Where the branch is checked out, which is where a human is sent. */
  path: string;
  /**
   * Whether this Run may push out of it: true for a worktree it created or was
   * resumed into, where a Stage of it could have left work. A worktree the
   * pipeline only found the branch checked out in holds a human's work.
   */
  pushable: boolean;
}

interface HandOff {
  issue: Issue;
  user: string;
  branch: string;
  /** Where the work is, absent when the Ticket failed before it had a worktree. */
  worktree?: HandOffWorktree;
  /**
   * Whether the State stays for a later Run to resume from: what the branch
   * carries is the pipeline's, whether or not this Run may push it.
   */
  keepsState: boolean;
  pullRequest: number | undefined;
  failure: TicketFailure;
  /** Whether the Ticket's fix budget had already been spent when this failure came. */
  fixUsed: boolean;
  /** The Ticket's State file, which the hand-off either leaves current or removes. */
  record: ResumeRecord;
  notes: RoutedNote[];
}

/**
 * Hand the Ticket to a human: a draft PR to review, a comment naming where the
 * work is, and the labels a human filters on. The branch, the worktree and the
 * State file stay put, so a human who relabels the Ticket `ready-for-agent`
 * hands it back and the next Run carries on from what it reached. The Stages'
 * transcripts go up beside the State, since the Host they were written on may
 * be gone by the time a human looks, and the comment says where they and the
 * branch are. The draft PR's body says where they are too, once they are
 * kept: a draft is opened first, because the State records it, and one that
 * was already open is rewritten, since its body is an earlier Run's.
 *
 * A Ticket handed over before its worktree was created has none: nothing was
 * branched, so there is no directory to name and nothing to push a draft PR out
 * of. Both are left out rather than written as a path that is not there and a
 * push that fails.
 *
 * Where a human is sent and what the pipeline pushes are two different facts. A
 * Ticket refused at setup over a branch still checked out somewhere names that
 * worktree and stops there: the work in it is a human's, and pushing it or
 * opening a PR that says `Closes #<n>` over it would claim it for this Run.
 *
 * The same fact mostly decides the State file. A worktree this Run may push out
 * of is one a Stage of it worked in, and what it left is the pipeline's to
 * resume; a branch in the way at setup leaves nothing of the pipeline's behind,
 * and a file kept over it would let a later Run resume into a human's work and
 * run an implement Stage over it — which is what refusing at setup exists to
 * prevent. The one worktree this Run may not push out of whose State stays is
 * one parted from the remote branch: both copies are the pipeline's, and
 * pushing either over the other is the choice the human is handed.
 */
async function handOff(
  pipeline: Pipeline,
  {
    issue,
    user,
    branch,
    worktree,
    keepsState,
    pullRequest,
    failure,
    fixUsed,
    record,
    notes,
  }: HandOff,
): Promise<TicketOutcome> {
  const { tracker, workspace, config } = pipeline;
  const ticket = issue.number;

  // Nothing of this Run's is on the branch, so nothing may leave the Ticket
  // looking resumable: the next Run must not implement over what a human holds.
  // Wrapped because the hand-off itself — the draft PR, the comment, the labels
  // — is what a human is waiting for, and no file is worth losing it over.
  if (!keepsState) {
    try {
      await workspace.removeState(ticket);
    } catch (error) {
      pipeline.log?.(
        `#${ticket} handed off, but clearing its State file failed: ${(error as Error).message}`,
      );
    }
  }

  const draftBody = {
    ticket,
    stage: failure.point,
    failure: failure.summary,
    runId: pipeline.runId,
  };
  // Whether the draft's body is one this hand-off wrote, naming no transcripts.
  // One it only converted still says what its Run said, which is not this.
  let drafted = false;
  if (pullRequest !== undefined) {
    await tracker.convertPullRequestToDraft(pullRequest);
  } else if (worktree?.pushable === true) {
    // A draft PR is worth trying for, but never worth losing the relabel over.
    try {
      await workspace.push(worktree.path, branch);
      const pr = await tracker.createPullRequest({
        base: pipeline.baseBranch,
        head: branch,
        // Nothing here is merged, so there is no commit subject worth deriving.
        title: issue.title,
        body: draftPullRequestBody(draftBody),
        draft: true,
      });
      pullRequest = pr.number;
      drafted = true;
    } catch (error) {
      pipeline.log?.(`#${ticket} could not open a draft PR: ${(error as Error).message}`);
    }
  }

  if (keepsState) {
    // Written after the draft pull request, because that pull request is part of
    // what a resuming Run must not open a second one beside.
    //
    // The Fix budget goes back unspent: the Ticket only comes back through a
    // human's hands, and whatever they did to it is what the fresh budget is
    // for. Nothing is lost by it — the hand-off comment says the budget was
    // spent, and the Claim only marks that comment as history.
    await record.advance({
      fixUsed: false,
      ...(pullRequest === undefined ? {} : { pullRequest }),
    });
  }
  // Only beside a State that stays, because they go when it does, and after
  // it, so the State they sit beside is the one a resuming Run reads.
  const transcripts = keepsState ? await keepTranscripts(pipeline, ticket) : undefined;
  // A draft this hand-off opened went up before anything was kept, and one it
  // converted still carries an earlier body, so either learns where only now.
  if (pullRequest !== undefined && !(drafted && transcripts === undefined)) {
    try {
      await tracker.updatePullRequestBody(
        pullRequest,
        draftPullRequestBody({
          ...draftBody,
          ...(transcripts === undefined ? {} : { transcripts }),
        }),
      );
    } catch (error) {
      pipeline.log?.(
        `#${ticket} could not rewrite the body of PR #${pullRequest}: ${(error as Error).message}`,
      );
    }
  }
  const onRemote = await branchOnRemote(pipeline, ticket, branch);

  await tracker.comment(
    ticket,
    handoffComment({
      stage: failure.point,
      failure: failure.summary,
      branch,
      onRemote,
      ...(worktree === undefined ? {} : { worktree: worktree.path }),
      ...(transcripts === undefined ? {} : { transcripts }),
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

/**
 * Keep the transcripts of the Stages this Run ran for a handed-off Ticket on
 * the remote, where a human can still read them once this Host is gone, and
 * say where.
 *
 * Nothing when that fails, and the failure logged: the hand-off is what a
 * human is waiting for, and the transcripts are still on this Host for as long
 * as it lasts.
 */
async function keepTranscripts(
  pipeline: Pipeline,
  ticket: number,
): Promise<KeptTranscripts | undefined> {
  try {
    return await pipeline.workspace.keepTranscripts(ticket, pipeline.runId);
  } catch (error) {
    pipeline.log?.(
      `#${ticket} handed off, but keeping its transcripts failed: ${(error as Error).message}`,
    );
    return undefined;
  }
}

/**
 * Whether the remote has the branch, for a hand-off comment that says so only
 * when it does. A remote that cannot be asked counts as no: saying less than
 * is so sends nobody looking for a branch that is not there.
 */
async function branchOnRemote(pipeline: Pipeline, ticket: number, branch: string): Promise<boolean> {
  try {
    return await pipeline.workspace.hasRemoteBranch(branch);
  } catch (error) {
    pipeline.log?.(`#${ticket} could not ask the remote for ${branch}: ${(error as Error).message}`);
    return false;
  }
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
 * on the base branch, and neither is a Ticket the Stage left no commits on: the
 * Ticket title says at least as much.
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
