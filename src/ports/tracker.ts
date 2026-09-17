/**
 * The issue tracker the pipeline claims Tickets from and reports back to.
 *
 * Every GitHub effect the orchestrator performs goes through this port, so the
 * state machine can be driven by an in-memory fake in tests.
 */

export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  number: number;
  title: string;
  url: string;
  body: string;
  labels: string[];
  assignees: string[];
  comments: string[];
}

export interface PullRequestRef {
  number: number;
  url: string;
}

export interface CreatePullRequest {
  head: string;
  title: string;
  body: string;
  draft: boolean;
}

/**
 * The outcome of waiting for a pull request's CI checks. Distinct from a Check,
 * which is a command the pipeline runs itself (CONTEXT.md).
 *
 * `none` means the PR has no checks at all, which `gates.ci` treats as a
 * failure rather than a silent bypass.
 */
export type CiOutcome =
  | { state: "passed" }
  | { state: "failed"; summary: string }
  | { state: "none" }
  | { state: "timed-out" };

export interface Tracker {
  currentUser(): Promise<string>;
  listLabels(): Promise<string[]>;
  createLabel(label: LabelSpec): Promise<void>;
  getIssue(number: number): Promise<Issue>;
  assign(number: number, user: string): Promise<void>;
  unassign(number: number, user: string): Promise<void>;
  addLabel(number: number, label: string): Promise<void>;
  removeLabel(number: number, label: string): Promise<void>;
  comment(number: number, body: string): Promise<void>;
  createPullRequest(pr: CreatePullRequest): Promise<PullRequestRef>;
  convertPullRequestToDraft(number: number): Promise<void>;
  waitForCi(number: number, timeoutMs: number): Promise<CiOutcome>;
  squashMerge(number: number): Promise<void>;
}
