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
  /**
   * GitHub's own id for the comment, as {@link Tracker.updateComment} takes it.
   *
   * Absent when the tracker reported a comment it gave no id for, which means
   * nothing more than that this one cannot be edited. Reading an issue must not
   * fail over it: the bodies are what the guards grade a candidate on, and
   * whether a comment can be rewritten decides nothing.
   */
  id?: string;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  url: string;
  body: string;
  /**
   * Whether the issue is closed.
   *
   * Only ever asked of a Ticket the pipeline kept local state for: a Run sweeps
   * its State files before it does anything else, and a Ticket that has closed
   * since is one there is nothing left to resume.
   */
  closed: boolean;
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

/**
 * A new issue the pipeline opens itself. Only ever a Note nobody had a Ticket
 * for, so it arrives untriaged: labelled `needs-triage` and nothing else.
 */
export interface CreateIssue {
  title: string;
  body: string;
  labels: string[];
}

export interface IssueRef {
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
  | {
      state: "failed";
      /** The one line a human reads in a notification: which checks went red. */
      summary: string;
      /**
       * The tail of the failing job's log, as the fix Stage's evidence.
       *
       * The names alone say nothing a fix Stage can work from: it cannot see
       * the CI log, and a failure that only happens on the runner may not
       * reproduce in the worktree. Empty when no log could be fetched — the
       * checks are not all GitHub Actions jobs and a tracker owes the caller
       * the failure either way — so every reader of it degrades to the summary.
       */
      excerpt: string;
    }
  | { state: "none" }
  | { state: "timed-out" };

export interface Tracker {
  currentUser(): Promise<string>;
  listLabels(): Promise<string[]>;
  createLabel(label: LabelSpec): Promise<void>;
  getIssue(number: number): Promise<Issue>;
  /** Open an issue, and say which one it is so a summary can name it. */
  createIssue(issue: CreateIssue): Promise<IssueRef>;
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
