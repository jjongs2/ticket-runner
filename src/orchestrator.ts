import { branchName, worktreePath } from "./branch.js";
import type { Config } from "./config.js";
import type { FailurePoint } from "./lifecycle.js";
import type { AgentRunner, StageFailure, StageResult } from "./ports/agent-runner.js";
import type { Issue, Tracker } from "./ports/tracker.js";
import type { Workspace } from "./ports/workspace.js";
import { implementPrompt, verifyPrompt } from "./prompts.js";
import { stageLogDir } from "./run-log.js";
import {
  draftPullRequestBody,
  handoffComment,
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

/** A failure that ends the Ticket. The skeleton has no fix Stage, so every one of these is a hand-off. */
class TicketFailure extends Error {
  constructor(
    readonly point: FailurePoint,
    readonly summary: string,
    readonly evidence: string = "",
  ) {
    super(summary);
  }
}

/**
 * Take one Ticket from claimed to merged, or hand it to a human.
 *
 * The happy path is: claim → worktree and branch → implement Stage → Checks →
 * verify Stage → rebase → PR → CI → squash merge → cleanup. Any failure along
 * the way ends in a hand-off, never in a merge.
 */
export async function processTicket(
  pipeline: Pipeline,
  ticket: number,
): Promise<TicketOutcome> {
  const { tracker, workspace, config, repoRoot } = pipeline;
  const log = pipeline.log ?? (() => {});

  const issue = await tracker.getIssue(ticket);
  const user = await tracker.currentUser();
  const branch = branchName(ticket, issue.title);
  const worktree = worktreePath(repoRoot, ticket);

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

  try {
    await workspace.createWorktree({ path: worktree, branch });

    point = "implement";
    await implement(pipeline, issue, worktree, branch);
    point = "checks";
    await runChecks(pipeline, worktree);
    point = "verify";
    const verdict = await verify(pipeline, issue, worktree);

    point = "rebase";
    const rebase = await workspace.rebaseOnMain(worktree);
    if (!rebase.ok) {
      throw new TicketFailure("rebase", "the branch does not rebase onto main", rebase.conflict);
    }

    point = "pr";
    // Read after the rebase, because these are the commits that land on main.
    const commits = await workspace.commitSubjects(branch);
    const title = pullRequestTitle(issue, commits);
    pullRequest = await openPullRequest(pipeline, issue, branch, worktree, verdict, title);
    point = "ci";
    await requireGreenCi(pipeline, pullRequest);

    point = "merge";
    await tracker.squashMerge(
      pullRequest,
      squashCommit({ ticket, title, verdict, commits }),
    );
  } catch (error) {
    const failure =
      error instanceof TicketFailure
        ? error
        : new TicketFailure(point, (error as Error).message);
    return handOff(pipeline, { issue, user, branch, worktree, pullRequest, failure });
  }

  // The Ticket is merged from here on, so nothing below may hand it off.
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

async function implement(
  pipeline: Pipeline,
  issue: Issue,
  worktree: string,
  branch: string,
): Promise<void> {
  const stage = pipeline.config.stages.implement;
  const result = await pipeline.runner.run({
    stage: "implement",
    prompt: implementPrompt(issue.url, stage.extraPrompt),
    cwd: worktree,
    logDir: stageLogDir(pipeline.repoRoot, pipeline.runId, issue.number),
    permissionMode: pipeline.config.permissionMode,
    model: stage.model,
    maxTurns: stage.maxTurns,
    maxMinutes: stage.maxMinutes,
  });
  if (!result.ok) {
    throw new TicketFailure("implement", describeStageFailure("implement", stage, result));
  }

  // An agent that gave up silently leaves a clean branch behind. That is a
  // failure, not something to verify.
  if ((await pipeline.workspace.commitSubjects(branch)).length === 0) {
    throw new TicketFailure(
      "implement",
      "the implement Stage left no new commits on the branch",
    );
  }
}

async function runChecks(pipeline: Pipeline, worktree: string): Promise<void> {
  for (const command of pipeline.config.checks) {
    const result = await pipeline.workspace.runCheck(command, worktree);
    if (!result.ok) {
      throw new TicketFailure("checks", `Check \`${command}\` failed`, result.output);
    }
  }
}

async function verify(
  pipeline: Pipeline,
  issue: Issue,
  worktree: string,
): Promise<Verdict> {
  const stage = pipeline.config.stages.verify;
  const result = await pipeline.runner.run({
    stage: "verify",
    prompt: verifyPrompt(issue.url, stage.extraPrompt),
    cwd: worktree,
    logDir: stageLogDir(pipeline.repoRoot, pipeline.runId, issue.number),
    permissionMode: pipeline.config.permissionMode,
    model: stage.model,
    maxTurns: stage.maxTurns,
    maxMinutes: stage.maxMinutes,
    jsonSchema: VERDICT_JSON_SCHEMA,
  });

  // verify is allowed to write throwaway tests; none of them reach the PR.
  await pipeline.workspace.discardChanges(worktree);

  if (!result.ok) {
    throw new TicketFailure("verify", describeStageFailure("verify", stage, result));
  }

  let verdict: Verdict;
  try {
    verdict = parseVerdict(result.result);
  } catch (error) {
    throw new TicketFailure(
      "verify",
      "the verify Stage did not return a usable Verdict",
      (error as Error).message,
    );
  }

  // The agent's own `pass` is advisory; this is the decision that counts.
  if (!passes(verdict)) {
    const unmet = unmetCriteria(verdict);
    if (unmet.length === 0) {
      throw new TicketFailure(
        "verify",
        "every criterion came back unverifiable, so there is no evidence to merge on",
        verdict.criteria.map((c) => `- ${c.text} — ${c.evidence}`).join("\n"),
      );
    }
    throw new TicketFailure(
      "verify",
      `${unmet.length} of ${verdict.criteria.length} criteria unmet`,
      unmet.map((c) => `- ${c.text} — ${c.evidence}`).join("\n"),
    );
  }

  const counts = countStatuses(verdict);
  pipeline.log?.(
    `#${issue.number} verified · ${counts.met} met · ${counts.unverifiable} unverifiable`,
  );
  return verdict;
}

async function openPullRequest(
  pipeline: Pipeline,
  issue: Issue,
  branch: string,
  worktree: string,
  verdict: Verdict,
  title: string,
): Promise<number> {
  await pipeline.workspace.push(worktree, branch);
  const pr = await pipeline.tracker.createPullRequest({
    head: branch,
    title,
    body: pullRequestBody({
      ticket: issue.number,
      verdict,
      runId: pipeline.runId,
    }),
    draft: false,
  });
  return pr.number;
}

/**
 * A red or unfinished pull request is a failure whatever the gates say. Turning
 * `gates.ci` off only tolerates a pull request that has no checks at all.
 */
async function requireGreenCi(pipeline: Pipeline, pullRequest: number): Promise<void> {
  const outcome = await pipeline.tracker.waitForCi(
    pullRequest,
    pipeline.config.ciTimeoutMinutes * 60_000,
  );

  switch (outcome.state) {
    case "passed":
      return;
    case "failed":
      throw new TicketFailure("ci", "a pull request check failed", outcome.summary);
    case "timed-out":
      throw new TicketFailure(
        "ci",
        `the pull request checks did not finish within ${pipeline.config.ciTimeoutMinutes} minutes`,
      );
    case "none":
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
}

/**
 * Hand the Ticket to a human: a draft PR to review, a comment naming where the
 * work is, and the labels a human filters on. The worktree and branch stay put.
 */
async function handOff(
  pipeline: Pipeline,
  { issue, user, branch, worktree, pullRequest, failure }: HandOff,
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
function pullRequestTitle(issue: Issue, commits: string[]): string {
  const first = (commits[0] ?? "").replace(TICKET_REFERENCE, "");
  return CONVENTIONAL_SUBJECT.test(first) ? first : issue.title;
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
