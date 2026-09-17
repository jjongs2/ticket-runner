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

/**
 * One comment on an issue, carried with the id the pipeline edits it by.
 *
 * The pipeline writes comments it later has to find and change — the progress
 * comment it edits every Stage, the Acceptance Criteria it ticks when a Ticket
 * merges — so a body on its own is not enough to go on.
 */
export interface IssueComment {
  /** GitHub's own id for the comment, as {@link Tracker.updateComment} takes it. */
  id: string;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  url: string;
  body: string;
  labels: string[];
  assignees: string[];
  comments: IssueComment[];
  /** How many native sub-issues it has; anything above zero is a Spec. */
  subIssues: number;
  /**
   * The issues GitHub records as blocking this one, open or closed. The body's
   * own `Blocked by` section is never a substitute for these (ADR-0003).
   */
  blockedBy: number[];
}

/**
 * What the Frontier is computed from: one open issue carrying the
 * `ready-for-agent` label, with the two facts that can keep it off the
 * Frontier.
 */
export interface Candidate {
  number: number;
  title: string;
  assignees: string[];
  /**
   * Open `blocked by` issues, from GitHub's native dependency summary. Body
   * text is never read (ADR-0003).
   */
  openBlockers: number;
}

/**
 * The commit a squash merge lands on main. Both halves are used verbatim, so
 * GitHub appends no pull request number to the subject.
 */
export interface SquashCommit {
  subject: string;
  body: string;
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
  /** Every open issue carrying `label`, in no particular order. */
  listCandidates(label: string): Promise<Candidate[]>;
  assign(number: number, user: string): Promise<void>;
  unassign(number: number, user: string): Promise<void>;
  addLabel(number: number, label: string): Promise<void>;
  removeLabel(number: number, label: string): Promise<void>;
  /** Post a comment, and say which one it is so it can be edited later. */
  comment(number: number, body: string): Promise<IssueComment>;
  /** Replace a comment's body, leaving it where it is in the thread. */
  updateComment(id: string, body: string): Promise<void>;
  /**
   * Replace an issue's body.
   *
   * Only ever used to tick Acceptance Criteria a Verdict proved, so whatever
   * else the body says is read first and written back unchanged.
   */
  updateIssueBody(number: number, body: string): Promise<void>;
  createPullRequest(pr: CreatePullRequest): Promise<PullRequestRef>;
  convertPullRequestToDraft(number: number): Promise<void>;
  /**
   * Replace the body of an open pull request.
   *
   * A Ticket that spends its fix budget is graded twice, and the body carries
   * the Verdict a human reads; without this it would keep the Verdict that
   * failed while the squash commit carried the one that passed.
   */
  updatePullRequestBody(number: number, body: string): Promise<void>;
  waitForCi(number: number, timeoutMs: number): Promise<CiOutcome>;
  squashMerge(number: number, commit: SquashCommit): Promise<void>;
}
