import { branchName, worktreePath } from "./branch.js";
import type { Config } from "./config.js";
import { tickCriteria } from "./criteria.js";
import { type SkipReason, isGuardReason, skipReason } from "./guards.js";
import type { FailureKind, FailurePoint } from "./lifecycle.js";
import type {
  AgentRunner,
  StageFailure,
  StageName,
  StageResult,
} from "./ports/agent-runner.js";
import type { Issue, Tracker } from "./ports/tracker.js";
import type { Workspace } from "./ports/workspace.js";
import { Progress, type ProgressRow, type ProgressStage } from "./progress.js";
import {
  type FixFailure,
  conflictPrompt,
  fixPrompt,
  implementPrompt,
  verifyPrompt,
} from "./prompts.js";
import { retryLogDir, stageLogDir } from "./run-log.js";
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
    }
  | {
      outcome: "handed-off";
      ticket: number;
      title: string;
      branch: string;
      stage: FailurePoint;
      failure: string;
      pullRequest?: number;
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
 * The guards come before the claim, so an issue the pipeline will not take is
 * never marked as taken. A Run has already dropped the claimed and the
 * untriaged from its Frontier; `ticket <n>` names an issue by hand and reaches
 * those guards too.
 */
export async function processTicket(
  pipeline: Pipeline,
  ticket: number,
): Promise<TicketOutcome> {
  const { tracker, workspace, config, repoRoot, runId } = pipeline;
  const log = pipeline.log ?? (() => {});

  const issue = await tracker.getIssue(ticket);
  const skip = skipReason(issue, config.labels.readyForAgent);
  if (skip !== undefined) return await passOver(pipeline, issue, skip);

  const user = await tracker.currentUser();
  const branch = branchName(ticket, issue.title);
  const worktree = worktreePath(repoRoot, ticket);
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

  // The claim is the first write: the board shows what the pipeline holds
  // before anything else can go wrong.
  await tracker.assign(ticket, user);
  await tracker.addLabel(ticket, config.labels.inProgress);
  await tracker.removeLabel(ticket, config.labels.readyForAgent);
  log(`#${ticket} claimed · ${branch}`);

  let pullRequest: number | undefined;
  // Where an unexpected error would have happened, so the hand-off comment
  // names the step the human has to look at rather than guessing.
  let point: FailurePoint = "setup";
  // The fix budget, which is one per Ticket and spent by the first failure a
  // fix Stage is offered. Once it is gone the next failure of any kind — even a
  // kind the fix Stage never touched — is a hand-off.
  let fixUsed = false;
  // The pass behind a fix Stage logs beside the first one rather than over it.
  let logDir = stageLogDir(repoRoot, runId, ticket);

  // Declared out here because ticking the Acceptance Criteria it proved happens
  // after the merge, where a failure may no longer hand the Ticket off.
  let verdict: Verdict;

  try {
    await workspace.createWorktree({ path: worktree, branch });

    point = "implement";
    await implement(pipeline, issue, worktree, branch, logDir, progress);

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
        point = "ci";
        await requireGreenCi(pipeline, pullRequest, progress);
        break;
      } catch (error) {
        const failure = asTicketFailure(error, point);
        if (fixUsed || failure.kind === undefined) throw failure;
        fixUsed = true;
        point = "fix";
        logDir = retryLogDir(repoRoot, runId, ticket);
        await fix(pipeline, issue, worktree, logDir, progress, {
          kind: failure.kind,
          summary: failure.summary,
          evidence: failure.evidence,
        });
      }
    }

    point = "merge";
    await tracker.squashMerge(
      pullRequest,
      squashCommit({ ticket, pullRequest, title, verdict, commits, coAuthors }),
    );
    await progress.record({ stage: "merge", outcome: `✅ #${pullRequest}` });
  } catch (error) {
    return handOff(pipeline, {
      issue,
      user,
      branch,
      worktree,
      pullRequest,
      failure: asTicketFailure(error, point),
      fixUsed,
    });
  }

  // The Ticket is merged from here on, so nothing below may hand it off.
  try {
    await tickMetCriteria(pipeline, ticket, verdict);
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

  return { outcome: "merged", ticket, title: issue.title, branch, pullRequest };
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
  request: { prompt: string; cwd: string; logDir: string; jsonSchema?: unknown },
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
  });
}

async function implement(
  pipeline: Pipeline,
  issue: Issue,
  worktree: string,
  branch: string,
  logDir: string,
  progress: Progress,
): Promise<void> {
  const stage = pipeline.config.stages.implement;
  const result = await runStage(pipeline, "implement", {
    prompt: implementPrompt(issue.url, stage.extraPrompt),
    cwd: worktree,
    logDir,
  });
  if (!result.ok) {
    await progress.record(stageRow("implement", result, `❌ ${stageFailureCell(result)}`));
    throw new TicketFailure("implement", describeStageFailure("implement", stage, result));
  }

  // An agent that gave up silently leaves a clean branch behind. That is a
  // failure, not something to verify.
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
  for (const command of pipeline.config.checks) {
    const result = await pipeline.workspace.runCheck(command, worktree);
    if (!result.ok) {
      await progress.record({
        stage: "checks",
        outcome: `❌ \`${command}\` failed`,
        durationMs: Date.now() - startedAt,
      });
      throw new TicketFailure(
        "checks",
        `Check \`${command}\` failed`,
        result.output,
        "failed-check",
      );
    }
  }
  await progress.record({
    stage: "checks",
    outcome: "✅ passed",
    durationMs: Date.now() - startedAt,
  });
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

  if (!result.ok) {
    await progress.record(stageRow("verify", result, `❌ ${stageFailureCell(result)}`));
    throw new TicketFailure("verify", describeStageFailure("verify", stage, result));
  }

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
  logDir: string,
  progress: Progress,
  failure: FixFailure,
): Promise<void> {
  const stage = pipeline.config.stages.fix;
  pipeline.log?.(`#${issue.number} fixing · ${failure.summary}`);

  const result = await runStage(pipeline, "fix", {
    prompt: fixPrompt(issue.url, failure, stage.extraPrompt),
    cwd: worktree,
    logDir,
  });
  if (!result.ok) {
    await progress.record(stageRow("fix", result, `❌ ${stageFailureCell(result)}`));
    throw new TicketFailure("fix", describeStageFailure("fix", stage, result));
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
): Promise<TicketFailure | undefined> {
  const stage = pipeline.config.stages.conflict;
  try {
    const result = await runStage(pipeline, "conflict", {
      prompt: conflictPrompt(issue.url, conflict, stage.extraPrompt),
      cwd: worktree,
      logDir,
    });

    const state = await pipeline.workspace.rebaseState(worktree);
    // The worktree decides the row, as it decides the outcome: a Stage that ran
    // out of turns after finishing the rebase did the job it was sent to do.
    await progress.record(
      stageRow("conflict", result, state.resolved ? "✅ rebased" : "❌ unresolved"),
    );
    if (state.resolved) return undefined;

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
    await progress.record({ stage: "conflict", outcome: "❌ unresolved" });
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
    progress.record({ stage: "ci", outcome: cell, durationMs: Date.now() - startedAt });

  switch (outcome.state) {
    case "passed":
      await record("✅ passed");
      return;
    case "failed":
      await record("❌ failed");
      throw new TicketFailure(
        "ci",
        "a pull request check failed",
        outcome.summary,
        "failed-ci",
      );
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

interface HandOff {
  issue: Issue;
  user: string;
  branch: string;
  worktree: string;
  pullRequest: number | undefined;
  failure: TicketFailure;
  /** Whether the Ticket's fix budget had already been spent when this failure came. */
  fixUsed: boolean;
}

/**
 * Hand the Ticket to a human: a draft PR to review, a comment naming where the
 * work is, and the labels a human filters on. The worktree and branch stay put.
 */
async function handOff(
  pipeline: Pipeline,
  { issue, user, branch, worktree, pullRequest, failure, fixUsed }: HandOff,
): Promise<TicketOutcome> {
  const { tracker, workspace, config } = pipeline;
  const ticket = issue.number;

  if (pullRequest !== undefined) {
    await tracker.convertPullRequestToDraft(pullRequest);
  } else {
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
      worktree,
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
  stage: ProgressStage,
  result: StageResult,
  outcome: string,
): ProgressRow {
  return {
    stage,
    outcome,
    ...(result.turns === undefined ? {} : { turns: result.turns }),
    durationMs: result.durationMs,
  };
}

/** The short form of a Stage failure, for a table cell rather than a sentence. */
const STAGE_FAILURE_CELLS: Record<StageFailure, string> = {
  "rate-limited": "rate limited",
  "timed-out": "timed out",
  "turn-capped": "turn capped",
  "nonzero-exit": "exited non-zero",
  "invalid-result": "invalid result",
};

function stageFailureCell(result: StageResult): string {
  return result.failure ? STAGE_FAILURE_CELLS[result.failure] : "failed";
}

/**
 * Tick every Acceptance Criterion the Verdict proved, where it lives.
 *
 * The issue is read again rather than reusing the copy the Ticket was claimed
 * with: a whole Run has happened since, and this writes the body back whole.
 * `unverifiable` criteria stay unticked, because nobody gathered the evidence
 * that would justify the tick.
 */
async function tickMetCriteria(
  pipeline: Pipeline,
  ticket: number,
  verdict: Verdict,
): Promise<void> {
  const met = verdict.criteria
    .filter((criterion) => criterion.status === "met")
    .map((criterion) => criterion.text);
  if (met.length === 0) return;

  const issue = await pipeline.tracker.getIssue(ticket);
  const body = tickCriteria(issue.body, met);
  if (body !== issue.body) await pipeline.tracker.updateIssueBody(ticket, body);

  // Triage posts its brief as a comment, so the criteria are not always in the
  // body, and nothing says they are all in one place.
  for (const comment of issue.comments) {
    const ticked = tickCriteria(comment.body, met);
    if (ticked !== comment.body) await pipeline.tracker.updateComment(comment.id, ticked);
  }
}

function describeStageFailure(
  stage: string,
  limits: { maxTurns: number; maxMinutes: number },
  result: StageResult,
): string {
  const reasons: Record<StageFailure, string> = {
    "rate-limited": "hit the subscription rate limit",
    "timed-out": `ran past its ${limits.maxMinutes} minute limit`,
    "turn-capped": `hit its ${limits.maxTurns} turn limit`,
    "nonzero-exit": "exited non-zero",
    "invalid-result": "returned output the Verdict schema rejected",
  };
  const reason = result.failure ? reasons[result.failure] : "failed";
  return `the ${stage} Stage ${reason}`;
}
