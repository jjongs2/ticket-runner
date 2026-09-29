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
  /**
   * Every comment on the issue, oldest first.
   *
   * The order is part of the answer: a Ticket can carry more than one comment
   * wearing the same marker — a second progress table, a second hand-off — and
   * the newest is the one the pipeline is writing now.
   */
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
   * Open `blocked by` issues, counted off GitHub's native dependency list for
   * the issue. Body text is never read (ADR-0003).
   */
  openBlockers: number;
}

/**
 * The commit a squash merge lands on the base branch. Both halves are used
 * verbatim, so GitHub appends no pull request number to the subject.
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
 * A new issue the pipeline opens itself. Only ever the standing Notes issue,
 * which the Notes nobody had a Ticket for are gathered on as comments, so it
 * arrives untriaged: labelled `needs-triage` and nothing else.
 */
export interface CreateIssue {
  title: string;
  body: string;
  labels: string[];
}

/** An open pull request, and the branch it would merge. */
export interface OpenPullRequest {
  number: number;
  head: string;
}

export interface IssueRef {
  number: number;
  url: string;
}

export interface CreatePullRequest {
  /** The branch it merges into: the Target's base branch, as the Run resolved it. */
  base: string;
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
 *
 * `conflicting` means the PR has no checks because GitHub reports it as
 * conflicting with the Base branch: GitHub runs no `pull_request` workflow for
 * such a PR, so it would otherwise read as `none`. It cannot be merged, so no gate
 * lets it through, and it has nothing a fix Stage could act on.
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
       * reproduce in the worktree. A failing job whose log could not be
       * fetched is named with where to find it and a note that its log was
       * unavailable, since the failure is owed to the caller either way. Empty
       * when no failing check was an Actions job, so every reader of it
       * degrades to the summary.
       */
      excerpt: string;
    }
  | { state: "none" }
  | { state: "conflicting" }
  | { state: "timed-out" };

/**
 * How `gh` answers on this Host: it speaks to GitHub as somebody, it runs but
 * as nobody, or it cannot be run at all. The last two want different things
 * of the human — a login, and an install — so they are never one answer.
 */
export type Authentication = "authenticated" | "unauthenticated" | "not-installed";

/**
 * What a number is on the Target. GitHub numbers issues and pull requests
 * from one sequence, so a number a human types can be either, or neither.
 */
export type NumberKind = "issue" | "pull-request" | "nothing";

export interface Tracker {
  /**
   * Whether `gh` can speak to GitHub as somebody, and if not, whether it is
   * there to be logged in.
   *
   * `init` reports the answer, and Target readiness refuses a Host with no
   * `gh` on it before its first GitHub question, which would otherwise fail on
   * the spawn. Every other operation of this port fails loudly without a login,
   * which is all a Run needs to know about that one.
   */
  authentication(): Promise<Authentication>;
  currentUser(): Promise<string>;
  /**
   * The branch GitHub calls the Target's default.
   *
   * Asked once at the start of a Run, and only where the config names no
   * `baseBranch` of its own: it is what a Run branches from, rebases onto,
   * merges into and pulls, so a repository on `master` needs no config file.
   */
  defaultBranch(): Promise<string>;
  /**
   * The Target's GitHub repository as `owner/name`, or nothing where GitHub
   * could not be asked.
   *
   * Asked once at the start of a Run, to learn whether the Target is the
   * pipeline's own repository, which decides what each Stage is told about the
   * checkout it stands in. Nothing is refused over the answer, so no answer is
   * an answer: a Target this cannot name is treated as any other Target.
   */
  repository(): Promise<string | undefined>;
  /**
   * The tag of the highest Version `repository` has published as a GitHub
   * Release, named `owner/name`, or nothing where GitHub could not be asked.
   *
   * Named for the tag rather than for the Release, because a Release in this
   * codebase is what a rate-limited Stage does to a Ticket (CONTEXT.md). A
   * published GitHub Release is what makes a tag a Version anybody can install,
   * which is why it is the question rather than the tag alone.
   *
   * The one method of this port that is not about the Target: it is asked about
   * the pipeline's own repository, so a Run and `init` can say that a newer
   * Version is out. Nothing is ever refused over the answer, so no answer is an
   * answer — a Target with no network is a Target that works (ADR-0007).
   *
   * Drafts and pre-releases are not published Versions and are not counted. The
   * tag comes back as it was cut, `v0.4.0`, because that is what a human would
   * go and look for.
   */
  latestVersionTag(repository: string): Promise<string | undefined>;
  listLabels(): Promise<string[]>;
  /**
   * Create a label, and say whether this call is what made it.
   *
   * A label the Target already has answers `false` rather than throwing, and is
   * left as it is: GitHub seeds a new repository's default labels a few seconds
   * after making it, so one can arrive between a listing that lacked it and
   * this create. Every other refusal still throws.
   */
  createLabel(label: LabelSpec): Promise<boolean>;
  /**
   * Delete a label, which GitHub takes off every issue wearing it, open or
   * closed, and say whether this call is what deleted it.
   *
   * A label the Target does not have answers `false` rather than throwing:
   * `ticket-runner remove` run twice finds it gone the second time.
   */
  deleteLabel(name: string): Promise<boolean>;
  /**
   * Allow squash merging on the Target, and change no other merge setting.
   *
   * The pipeline merges no other way, so a Target with squash merging off
   * refuses the merge at the end of every Ticket. Whether the Target also
   * allows merge commits or rebase merging is the Target's own policy.
   */
  enableSquashMerge(): Promise<void>;
  /**
   * Whether GitHub deletes a pull request's branch when it merges.
   *
   * A Target readiness item on every Host: a cloud Host can delete nothing on
   * the remote, so a merged Ticket's branch goes only when the repository takes
   * it (ADR-0008). Asked of a workstation too, so a Target it accepts is never
   * one a cloud Run then refuses.
   */
  deletesBranchOnMerge(): Promise<boolean>;
  /** Switch on {@link deletesBranchOnMerge}, and change no other setting. */
  enableDeleteBranchOnMerge(): Promise<void>;
  getIssue(number: number): Promise<Issue>;
  /**
   * Whether `number` is an issue, a pull request, or nothing the Target has.
   *
   * Asked of a number a human named to a Run that the Run then never met, so
   * the summary can say why: {@link getIssue} fails over a number with nothing
   * behind it, and reads a pull request as though it were an issue. A number
   * GitHub has nothing for, or had and deleted, is `nothing`; every other
   * failure throws.
   */
  numberKind(number: number): Promise<NumberKind>;
  /** Open an issue, and say which one it is so a summary can name it. */
  createIssue(issue: CreateIssue): Promise<IssueRef>;
  /**
   * Every open issue carrying `label`, in no particular order.
   *
   * The Frontier is computed from the `ready-for-agent` ones; the same call
   * under `needs-triage` is how a Run finds the standing Notes issue, which is
   * why being open is part of the question rather than a filter a caller
   * applies.
   */
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
  /**
   * Every open pull request on the Target, with its head branch, so what
   * `ticket-runner remove` leaves on an `agent/` branch can be named by the
   * pull request a human would go and look at.
   */
  openPullRequests(): Promise<OpenPullRequest[]>;
  convertPullRequestToDraft(number: number): Promise<void>;
  /**
   * Take an open pull request back out of draft.
   *
   * The other direction of {@link convertPullRequestToDraft}, and what a Run
   * that takes a handed-off Ticket back from a human owes the pull request the
   * Hand-off drafted: a draft cannot be merged. Asked before the wait for CI
   * rather than at the merge, because a draft pull request often runs no
   * workflows at all, and waiting on one first would read as "no checks".
   */
  markPullRequestReady(number: number): Promise<void>;
  /**
   * Replace the body of an open pull request.
   *
   * A Ticket that spends its fix budget is graded twice, and the body carries
   * the Verdict a human reads; without this it would keep the Verdict that
   * failed while the squash commit carried the one that passed.
   */
  updatePullRequestBody(number: number, body: string): Promise<void>;
  /**
   * Replace the title of an open pull request.
   *
   * The title is the subject of the squash commit, and a fix Stage may answer a
   * new one for a pull request an earlier pass already opened; without this the
   * pull request would keep the old title while a different subject landed.
   */
  updatePullRequestTitle(number: number, title: string): Promise<void>;
  waitForCi(number: number, timeoutMs: number): Promise<CiOutcome>;
  squashMerge(number: number, commit: SquashCommit): Promise<void>;
}
