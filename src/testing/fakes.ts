/**
 * In-memory fakes of the three ports.
 *
 * The orchestrator is driven entirely through these in tests, so the whole
 * unattended flow is covered without spending subscription budget or touching
 * GitHub. Each fake records an ordered `calls` log; tests assert on that and on
 * the resulting state, never on internal helper calls.
 */

import type {
  AgentRunner,
  StageName,
  StageRequest,
  StageResult,
} from "../ports/agent-runner.js";
import type {
  Candidate,
  CiOutcome,
  CreatePullRequest,
  Issue,
  IssueComment,
  LabelSpec,
  PullRequestRef,
  SquashCommit,
  Tracker,
} from "../ports/tracker.js";
import type {
  CheckOutcome,
  WorktreeRef,
  RebaseOutcome,
  RebaseState,
  Workspace,
} from "../ports/workspace.js";

export interface FakePullRequest extends CreatePullRequest {
  number: number;
  merged: boolean;
  /** What the merge composed, once it has happened. */
  squashCommit?: SquashCommit;
}

export class FakeTracker implements Tracker {
  user = "pipeline-user";
  labels = new Set<string>();
  createdLabels: LabelSpec[] = [];
  issues = new Map<number, Issue>();
  comments: { issue: number; body: string }[] = [];
  /** Every in-place comment edit, in order, as {@link updateComment} took it. */
  updatedComments: { id: string; body: string }[] = [];
  pullRequests: FakePullRequest[] = [];
  ci: CiOutcome = { state: "passed" };
  /** Outcomes for the next CI waits, oldest first; `ci` answers once they run out. */
  ciQueue: CiOutcome[] = [];
  /** Open blockers per issue number; anything unlisted has none. */
  openBlockers = new Map<number, number>();
  /** Issue numbers closed by a merge, which drop out of the candidate list. */
  closed = new Set<number>();
  /** Fires after a squash merge, for tests where merging unblocks something. */
  onSquashMerge: ((pullRequest: number) => void) | undefined;
  ciWaits: { pullRequest: number; timeoutMs: number }[] = [];
  calls: string[] = [];
  private nextCommentId = 1;

  addIssue(issue: Partial<Issue> & { number: number }): Issue {
    const full: Issue = {
      title: `Ticket ${issue.number}`,
      url: `https://github.com/acme/repo/issues/${issue.number}`,
      body: "- [ ] it works",
      labels: ["ready-for-agent"],
      assignees: [],
      comments: [],
      subIssues: 0,
      blockedBy: [],
      ...issue,
    };
    this.issues.set(full.number, full);
    return full;
  }

  issue(number: number): Issue {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`no such issue: #${number}`);
    return issue;
  }

  async currentUser(): Promise<string> {
    return this.user;
  }

  async listLabels(): Promise<string[]> {
    return [...this.labels];
  }

  async createLabel(label: LabelSpec): Promise<void> {
    this.calls.push(`createLabel:${label.name}`);
    this.createdLabels.push(label);
    this.labels.add(label.name);
  }

  async getIssue(number: number): Promise<Issue> {
    return structuredClone(this.issue(number));
  }

  /** Every open issue carrying `label`, deliberately in reverse number order. */
  async listCandidates(label: string): Promise<Candidate[]> {
    this.calls.push(`listCandidates:${label}`);
    return [...this.issues.values()]
      .filter((issue) => !this.closed.has(issue.number) && issue.labels.includes(label))
      .sort((a, b) => b.number - a.number)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        assignees: [...issue.assignees],
        openBlockers: this.openBlockers.get(issue.number) ?? 0,
      }));
  }

  async assign(number: number, user: string): Promise<void> {
    this.calls.push(`assign:${number}:${user}`);
    this.issue(number).assignees.push(user);
  }

  async unassign(number: number, user: string): Promise<void> {
    this.calls.push(`unassign:${number}:${user}`);
    const issue = this.issue(number);
    issue.assignees = issue.assignees.filter((a) => a !== user);
  }

  async addLabel(number: number, label: string): Promise<void> {
    this.calls.push(`addLabel:${number}:${label}`);
    const issue = this.issue(number);
    if (!issue.labels.includes(label)) issue.labels.push(label);
  }

  async removeLabel(number: number, label: string): Promise<void> {
    this.calls.push(`removeLabel:${number}:${label}`);
    const issue = this.issue(number);
    issue.labels = issue.labels.filter((l) => l !== label);
  }

  async comment(number: number, body: string): Promise<IssueComment> {
    this.calls.push(`comment:${number}`);
    this.comments.push({ issue: number, body });
    // A comment is on the issue from now on, which is what the next getIssue
    // has to see: the pipeline finds its own comments again by marker.
    const posted: IssueComment = { id: `c${this.nextCommentId++}`, body };
    this.issues.get(number)?.comments.push(posted);
    return { ...posted };
  }

  async updateComment(id: string, body: string): Promise<void> {
    this.calls.push(`updateComment:${id}`);
    this.updatedComments.push({ id, body });
    const comment = [...this.issues.values()]
      .flatMap((issue) => issue.comments)
      .find((candidate) => candidate.id === id);
    if (!comment) throw new Error(`no such comment: ${id}`);
    comment.body = body;
  }

  async updateIssueBody(number: number, body: string): Promise<void> {
    this.calls.push(`updateIssueBody:${number}`);
    this.issue(number).body = body;
  }

  async createPullRequest(pr: CreatePullRequest): Promise<PullRequestRef> {
    const number = 100 + this.pullRequests.length;
    this.calls.push(`createPullRequest:${number}:${pr.draft ? "draft" : "ready"}`);
    this.pullRequests.push({ ...pr, number, merged: false });
    return { number, url: `https://github.com/acme/repo/pull/${number}` };
  }

  async convertPullRequestToDraft(number: number): Promise<void> {
    this.calls.push(`convertPullRequestToDraft:${number}`);
    this.pullRequest(number).draft = true;
  }

  async updatePullRequestBody(number: number, body: string): Promise<void> {
    this.calls.push(`updatePullRequestBody:${number}`);
    this.pullRequest(number).body = body;
  }

  /** Queue the outcome of the next CI wait, overriding {@link ci} once. */
  queueCi(outcome: CiOutcome): this {
    this.ciQueue.push(outcome);
    return this;
  }

  async waitForCi(number: number, timeoutMs: number): Promise<CiOutcome> {
    this.calls.push(`waitForCi:${number}`);
    this.ciWaits.push({ pullRequest: number, timeoutMs });
    return this.ciQueue.shift() ?? this.ci;
  }

  async squashMerge(number: number, commit: SquashCommit): Promise<void> {
    this.calls.push(`squashMerge:${number}`);
    const pr = this.pullRequest(number);
    pr.merged = true;
    pr.squashCommit = commit;
    // The PR body closes the Ticket, which is how a Run's Frontier shrinks.
    const closes = /Closes #(\d+)/.exec(pr.body);
    if (closes) this.closed.add(Number.parseInt(closes[1] as string, 10));
    this.onSquashMerge?.(number);
  }

  pullRequest(number: number): FakePullRequest {
    const pr = this.pullRequests.find((candidate) => candidate.number === number);
    if (!pr) throw new Error(`no such pull request: #${number}`);
    return pr;
  }
}

export class FakeAgentRunner implements AgentRunner {
  requests: StageRequest[] = [];
  /** Queued results per Stage; the last one is reused once the queue drains. */
  private queued = new Map<StageName, StageResult[]>();

  constructor(private readonly defaults: Partial<Record<StageName, StageResult>> = {}) {}

  /** Queue the next result for a Stage, overriding the default. */
  queue(stage: StageName, result: Partial<StageResult>): this {
    const existing = this.queued.get(stage) ?? [];
    existing.push({ ...stageResult(), ...result });
    this.queued.set(stage, existing);
    return this;
  }

  prompts(stage: StageName): string[] {
    return this.requests.filter((r) => r.stage === stage).map((r) => r.prompt);
  }

  stages(): StageName[] {
    return this.requests.map((request) => request.stage);
  }

  async run(request: StageRequest): Promise<StageResult> {
    this.requests.push(request);
    const queued = this.queued.get(request.stage);
    if (queued && queued.length > 0) return queued.shift() as StageResult;
    return this.defaults[request.stage] ?? stageResult();
  }
}

export function stageResult(overrides: Partial<StageResult> = {}): StageResult {
  return {
    ok: true,
    commandLine: "claude -p ...",
    transcriptPath: "/logs/transcript.jsonl",
    turns: 7,
    durationMs: 1_000,
    ...overrides,
  };
}

export class FakeWorkspace implements Workspace {
  /** worktree path → branch, for the worktrees that currently exist. */
  worktrees = new Map<string, string>();
  calls: string[] = [];
  /** The branch's commit subjects, oldest first, as an implement Stage leaves them. */
  commits = ["feat(cli): do the thing (#2)", "test(cli): cover the thing (#2)"];
  coAuthorList: string[] = [];
  /** Check outcomes that stick, per command; a command with none always passes. */
  checkOutcomes = new Map<string, CheckOutcome>();
  /** Outcomes for the next runs of a command; `checkOutcomes` answers once they run out. */
  checkQueue = new Map<string, CheckOutcome[]>();
  ranChecks: { command: string; cwd: string }[] = [];
  rebase: RebaseOutcome = { ok: true };
  /** Outcomes for the next rebases, oldest first; `rebase` answers once they run out. */
  rebaseQueue: RebaseOutcome[] = [];
  /** What the worktree looks like once the conflict Stage has had its turn. */
  rebaseStateAfterStage: RebaseState = { resolved: true };
  aborts = 0;
  pushes: { cwd: string; branch: string }[] = [];
  pulledMain = 0;

  /** Fail `command` every time the pipeline runs it. */
  failCheck(command: string, output: string): this {
    this.checkOutcomes.set(command, { ok: false, output });
    return this;
  }

  /** Conflict on the next rebase only: a conflict the conflict Stage then resolves. */
  conflictOnce(conflict: string): this {
    this.rebaseQueue.push({ ok: false, conflict });
    return this;
  }

  /** Fail `command` on its next run only: a Check a fix Stage then mends. */
  failCheckOnce(command: string, output: string): this {
    const queued = this.checkQueue.get(command) ?? [];
    queued.push({ ok: false, output });
    this.checkQueue.set(command, queued);
    return this;
  }

  async createWorktree({ path, branch }: WorktreeRef): Promise<void> {
    this.calls.push(`createWorktree:${branch}`);
    this.worktrees.set(path, branch);
  }

  async removeWorktree({ path, branch }: WorktreeRef): Promise<void> {
    this.calls.push(`removeWorktree:${branch}`);
    this.worktrees.delete(path);
  }

  async commitSubjects(branch: string): Promise<string[]> {
    this.calls.push(`commitSubjects:${branch}`);
    return [...this.commits];
  }

  async coAuthors(branch: string): Promise<string[]> {
    this.calls.push(`coAuthors:${branch}`);
    return [...this.coAuthorList];
  }

  async runCheck(command: string, cwd: string): Promise<CheckOutcome> {
    this.calls.push(`runCheck:${command}`);
    this.ranChecks.push({ command, cwd });
    return (
      this.checkQueue.get(command)?.shift() ??
      this.checkOutcomes.get(command) ?? { ok: true, output: "" }
    );
  }

  async discardChanges(cwd: string): Promise<void> {
    this.calls.push(`discardChanges:${cwd}`);
  }

  async rebaseOnMain(): Promise<RebaseOutcome> {
    this.calls.push("rebaseOnMain");
    return this.rebaseQueue.shift() ?? this.rebase;
  }

  async rebaseState(): Promise<RebaseState> {
    this.calls.push("rebaseState");
    return this.rebaseStateAfterStage;
  }

  async abortRebase(): Promise<void> {
    this.calls.push("abortRebase");
    this.aborts += 1;
  }

  async push(cwd: string, branch: string): Promise<void> {
    this.calls.push(`push:${branch}`);
    this.pushes.push({ cwd, branch });
  }

  async deleteRemoteBranch(branch: string): Promise<void> {
    this.calls.push(`deleteRemoteBranch:${branch}`);
  }

  async pullMain(): Promise<void> {
    this.calls.push("pullMain");
    this.pulledMain += 1;
  }
}
