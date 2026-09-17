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
  CiOutcome,
  CreatePullRequest,
  Issue,
  LabelSpec,
  PullRequestRef,
  Tracker,
} from "../ports/tracker.js";
import type {
  CheckOutcome,
  WorktreeRef,
  RebaseOutcome,
  Workspace,
} from "../ports/workspace.js";

export interface FakePullRequest extends CreatePullRequest {
  number: number;
  merged: boolean;
}

export class FakeTracker implements Tracker {
  user = "pipeline-user";
  labels = new Set<string>();
  createdLabels: LabelSpec[] = [];
  issues = new Map<number, Issue>();
  comments: { issue: number; body: string }[] = [];
  pullRequests: FakePullRequest[] = [];
  ci: CiOutcome = { state: "passed" };
  ciWaits: { pullRequest: number; timeoutMs: number }[] = [];
  calls: string[] = [];

  addIssue(issue: Partial<Issue> & { number: number }): Issue {
    const full: Issue = {
      title: `Ticket ${issue.number}`,
      url: `https://github.com/acme/repo/issues/${issue.number}`,
      body: "- [ ] it works",
      labels: ["ready-for-agent"],
      assignees: [],
      comments: [],
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

  async comment(number: number, body: string): Promise<void> {
    this.calls.push(`comment:${number}`);
    this.comments.push({ issue: number, body });
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

  async waitForCi(number: number, timeoutMs: number): Promise<CiOutcome> {
    this.calls.push(`waitForCi:${number}`);
    this.ciWaits.push({ pullRequest: number, timeoutMs });
    return this.ci;
  }

  async squashMerge(number: number): Promise<void> {
    this.calls.push(`squashMerge:${number}`);
    this.pullRequest(number).merged = true;
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
  commits = 3;
  /** Per-command Check outcomes; anything unlisted passes. */
  checkOutcomes = new Map<string, CheckOutcome>();
  ranChecks: { command: string; cwd: string }[] = [];
  rebase: RebaseOutcome = { ok: true };
  pushes: { cwd: string; branch: string }[] = [];
  pulledMain = 0;

  failCheck(command: string, output: string): this {
    this.checkOutcomes.set(command, { ok: false, output });
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

  async commitCount(branch: string): Promise<number> {
    this.calls.push(`commitCount:${branch}`);
    return this.commits;
  }

  async runCheck(command: string, cwd: string): Promise<CheckOutcome> {
    this.calls.push(`runCheck:${command}`);
    this.ranChecks.push({ command, cwd });
    return this.checkOutcomes.get(command) ?? { ok: true, output: "" };
  }

  async discardChanges(cwd: string): Promise<void> {
    this.calls.push(`discardChanges:${cwd}`);
  }

  async rebaseOnMain(): Promise<RebaseOutcome> {
    this.calls.push("rebaseOnMain");
    return this.rebase;
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
