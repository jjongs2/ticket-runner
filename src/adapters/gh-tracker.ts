import type {
  Candidate,
  CiOutcome,
  CreateIssue,
  CreatePullRequest,
  Issue,
  IssueComment,
  IssueRef,
  LabelSpec,
  PullRequestRef,
  SquashCommit,
  Tracker,
} from "../ports/tracker.js";
import { type Execution, type RunProcess, exec, throwOnFailure } from "./exec.js";

export interface GhTrackerOptions {
  run?: RunProcess;
  cwd?: string;
  pollIntervalMs?: number;
  /** How long "no checks yet" counts as pending after the wait starts. */
  checksGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** One issue as `gh issue view --json` reports it. */
interface RawIssue {
  number: number;
  title: string;
  url: string;
  body: string;
  state: string;
  labels: { name: string }[];
  assignees: { login: string }[];
  comments: { body: string; url: string }[];
  subIssuesSummary?: { total?: number };
  blockedBy?: { nodes: { number: number }[] };
}

/** The fields the Frontier needs from one entry of the REST issue list. */
interface RawCandidate {
  number: number;
  title: string;
  assignees: { login: string }[] | null;
  /** Present on pull requests only; GitHub lists them as issues too. */
  pull_request?: unknown;
  /** `blocked_by` counts open blockers only, which is exactly the gate. */
  issue_dependencies_summary?: { blocked_by?: number };
}

/** One entry of `gh pr checks --json`. */
interface CiCheck {
  name: string;
  bucket: string;
  /** Where the check reports; an Actions job's is the only one a log is behind. */
  link?: string;
}

/**
 * What one reading of `gh pr checks` settled on, before any log is fetched.
 *
 * A failed reading keeps the checks themselves rather than only their names,
 * because the log fetch happens once, after the polling loop is over, and it
 * needs the links.
 */
type CiReading =
  | { state: "passed" }
  | { state: "none" }
  | { state: "failed"; summary: string; failed: CiCheck[] };

/**
 * The GitHub-backed {@link Tracker}, spoken through the `gh` CLI so it reuses
 * the repo's own auth and conventions.
 *
 * Argument building and output parsing, plus the one piece of waiting the port
 * owns: polling a pull request's CI until it settles or the caller's timeout
 * runs out. What that outcome means is the orchestrator's decision.
 */
export class GhTracker implements Tracker {
  private readonly runProcess: RunProcess;
  private readonly cwd: string | undefined;
  private readonly pollIntervalMs: number;
  private readonly checksGraceMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: GhTrackerOptions = {}) {
    this.runProcess = options.run ?? exec;
    this.cwd = options.cwd;
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.checksGraceMs = options.checksGraceMs ?? 120_000;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async currentUser(): Promise<string> {
    const { stdout } = await this.gh(["api", "user", "--jq", ".login"]);
    return stdout.trim();
  }

  /** Whatever the Target's `HEAD` points at, which `gh repo view` reports. */
  async defaultBranch(): Promise<string> {
    const { stdout } = await this.gh([
      "repo",
      "view",
      "--json",
      "defaultBranchRef",
      "--jq",
      ".defaultBranchRef.name",
    ]);
    const branch = stdout.trim();
    if (branch === "") throw new Error("gh reported no default branch for this repository");
    return branch;
  }

  async listLabels(): Promise<string[]> {
    const { stdout } = await this.gh(["label", "list", "--json", "name", "--limit", "200"]);
    return (JSON.parse(stdout) as { name: string }[]).map((label) => label.name);
  }

  async createLabel(label: LabelSpec): Promise<void> {
    await this.gh([
      "label",
      "create",
      label.name,
      "--color",
      label.color,
      "--description",
      label.description,
    ]);
  }

  /**
   * One issue, with the two native relations the guards read: how many
   * sub-issues it has, and what GitHub says blocks it. `gh issue view` reports
   * both, so the guards cost no extra call.
   */
  async getIssue(number: number): Promise<Issue> {
    const { stdout } = await this.gh([
      "issue",
      "view",
      String(number),
      "--json",
      "number,title,url,body,state,labels,assignees,comments,subIssuesSummary,blockedBy",
    ]);
    const raw = JSON.parse(stdout) as RawIssue;
    return {
      number: raw.number,
      title: raw.title,
      url: raw.url,
      body: raw.body ?? "",
      closed: raw.state === "CLOSED",
      labels: raw.labels.map((label) => label.name),
      assignees: raw.assignees.map((assignee) => assignee.login),
      comments: raw.comments.map((comment) => ({
        ...withCommentId(comment.url),
        body: comment.body,
      })),
      ...relations(raw),
    };
  }

  /**
   * Open an issue, and read its number back out of the URL `gh` prints.
   *
   * Every label is passed in one `--label`, so a repo missing one fails the
   * whole create rather than opening an issue nobody's filter will find.
   */
  async createIssue(issue: CreateIssue): Promise<IssueRef> {
    const { stdout } = await this.gh([
      "issue",
      "create",
      "--title",
      issue.title,
      "--body",
      issue.body,
      ...issue.labels.flatMap((label) => ["--label", label]),
    ]);
    const ref = refFromOutput(stdout);
    if (!ref) {
      throw new Error(`could not read an issue number from gh output: ${stdout}`);
    }
    return ref;
  }

  /**
   * The open issues carrying `label`, straight from the REST issue list.
   *
   * `gh issue list` cannot report blocking dependencies, so this goes to the
   * API for `issue_dependencies_summary`, the only blocker source the pipeline
   * trusts (ADR-0003).
   */
  async listCandidates(label: string): Promise<Candidate[]> {
    const { stdout } = await this.gh([
      "api",
      "--paginate",
      "--method",
      "GET",
      "repos/{owner}/{repo}/issues",
      "-f",
      "state=open",
      "-f",
      `labels=${label}`,
      "-F",
      "per_page=100",
    ]);

    const raw = JSON.parse(stdout) as RawCandidate[];
    return raw
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
        openBlockers: openBlockers(issue),
      }));
  }

  async assign(number: number, user: string): Promise<void> {
    await this.editIssue(number, "--add-assignee", user);
  }

  async unassign(number: number, user: string): Promise<void> {
    await this.editIssue(number, "--remove-assignee", user);
  }

  async addLabel(number: number, label: string): Promise<void> {
    await this.editIssue(number, "--add-label", label);
  }

  async removeLabel(number: number, label: string): Promise<void> {
    await this.editIssue(number, "--remove-label", label);
  }

  /** `gh` prints the new comment's URL, which is the only handle it gives back. */
  async comment(number: number, body: string): Promise<IssueComment> {
    const { stdout } = await this.gh(["issue", "comment", String(number), "--body", body]);
    return { ...withCommentId(lastLine(stdout)), body };
  }

  /**
   * Edit a comment in place.
   *
   * `gh` has no command for this, so it goes to the REST endpoint, which takes
   * the numeric id {@link commentId} reads out of a comment URL.
   */
  async updateComment(id: string, body: string): Promise<void> {
    await this.gh([
      "api",
      "--method",
      "PATCH",
      `repos/{owner}/{repo}/issues/comments/${id}`,
      "-f",
      `body=${body}`,
    ]);
  }

  async updateIssueBody(number: number, body: string): Promise<void> {
    await this.editIssue(number, "--body", body);
  }

  async createPullRequest(pr: CreatePullRequest): Promise<PullRequestRef> {
    const args = [
      "pr",
      "create",
      "--base",
      pr.base,
      "--head",
      pr.head,
      "--title",
      pr.title,
      "--body",
      pr.body,
    ];
    if (pr.draft) args.push("--draft");

    const { stdout } = await this.gh(args);
    const ref = refFromOutput(stdout);
    if (!ref) {
      throw new Error(`could not read a pull request number from gh output: ${stdout}`);
    }
    return ref;
  }

  async convertPullRequestToDraft(number: number): Promise<void> {
    await this.gh(["pr", "ready", String(number), "--undo"]);
  }

  async updatePullRequestBody(number: number, body: string): Promise<void> {
    await this.gh(["pr", "edit", String(number), "--body", body]);
  }

  /**
   * Poll the PR's CI until it settles or the timeout runs out. A PR with no
   * checks is reported as such, never as a pass.
   *
   * Right after a PR opens, GitHub answers "no checks" for a while before the
   * workflow's check run exists, so "no checks" only counts once the grace
   * period has passed.
   */
  async waitForCi(number: number, timeoutMs: number): Promise<CiOutcome> {
    const startedAt = this.now();
    const deadline = startedAt + timeoutMs;
    const graceUntil = startedAt + Math.min(this.checksGraceMs, timeoutMs);

    for (;;) {
      const result = await this.gh(
        ["pr", "checks", String(number), "--json", "name,bucket,state,link"],
        { allowFailure: true },
      );

      const reading = readCi(result);
      const stillRegistering = reading !== "pending" && reading.state === "none" && this.now() < graceUntil;
      if (reading !== "pending" && !stillRegistering) return this.withEvidence(reading);
      // Checks that never appeared are "none", not a timeout: nothing was ever pending.
      if (this.now() >= deadline) {
        return reading === "pending" ? { state: "timed-out" } : this.withEvidence(reading);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * The reading the poll stopped on, turned into the outcome the caller gets.
   *
   * The one place a job log is fetched, so it happens once per wait and never
   * while a check is still pending.
   */
  private async withEvidence(reading: CiReading): Promise<CiOutcome> {
    if (reading.state !== "failed") return reading;
    return {
      state: "failed",
      summary: reading.summary,
      excerpt: await this.failedJobLogs(reading.failed),
    };
  }

  /**
   * The tail of each failing Actions job's failed steps, best effort.
   *
   * Evidence is worth a few extra calls and nothing more: a Ticket whose CI
   * really is red has a failure to report whether or not a log came back, so
   * every way this can go wrong — a check that is not an Actions job, a `gh`
   * that fails or is not there, an empty log — yields no excerpt rather than
   * an error.
   *
   * The cap counts the jobs a log could be fetched for, not the red checks: a
   * PR whose external checks went red alongside one Actions job still gets the
   * one log there is. What it keeps out of a prompt is a whole matrix failing
   * a leg at a time, each leg with the same log.
   */
  private async failedJobLogs(failed: CiCheck[]): Promise<string> {
    const jobs = failed
      .map((check) => ({ name: check.name, job: actionsJobId(check.link) }))
      .filter((check): check is { name: string; job: string } => check.job !== undefined);

    const logs: string[] = [];
    for (const { name, job } of jobs.slice(0, MAX_LOG_JOBS)) {
      try {
        const result = await this.gh(["run", "view", "--job", job, "--log-failed"], {
          allowFailure: true,
        });
        if (result.exitCode !== 0) continue;
        const log = result.stdout.trim();
        if (log !== "") logs.push(`${name}\n${tail(log)}`);
      } catch {
        // `gh` itself could not be run. The failure still stands; the log does not.
      }
    }
    return logs.join("\n\n");
  }

  async squashMerge(number: number, commit: SquashCommit): Promise<void> {
    await this.gh([
      "pr",
      "merge",
      String(number),
      "--squash",
      "--subject",
      commit.subject,
      "--body",
      commit.body,
    ]);
  }

  private editIssue(number: number, flag: string, value: string) {
    return this.gh(["issue", "edit", String(number), flag, value]);
  }

  private async gh(
    args: string[],
    options: { allowFailure?: boolean } = {},
  ): Promise<Execution> {
    const result = await this.runProcess("gh", args, {
      ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
    });
    return options.allowFailure ? result : throwOnFailure("gh", args, result);
  }
}

/** The numeric id a comment URL ends in, which is what the REST API edits by. */
const COMMENT_ID = /#issuecomment-(\d+)\s*$/;

/** The URL `gh issue create` and `gh pr create` print, and the number it ends in. */
const ISSUE_OR_PR_URL = /^https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/(?:issues|pull)\/(\d+)$/;

/** The Actions job a check's link points at: `.../actions/runs/<run>/job/<job>`. */
const ACTIONS_JOB_URL = /\/actions\/runs\/\d+\/job\/(\d+)(?:[?#]|$)/;

/**
 * How many failing Actions jobs a single wait fetches a log for.
 *
 * A matrix build fails a leg at a time with the same log each time, and the
 * prompt and the hand-off comment both have to stay readable, so the excerpt
 * is bounded by this times {@link MAX_LOG_LINES} rather than by the build.
 */
const MAX_LOG_JOBS = 3;

/** Lines kept from the tail of one job's log. */
const MAX_LOG_LINES = 40;

/** Characters kept from the tail of one job's log, for lines long enough to need it. */
const MAX_LOG_CHARS = 4_000;

/** The one line of `gh` output that carries the handle it gives back. */
function lastLine(stdout: string): string {
  return stdout.trim().split("\n").at(-1)?.trim() ?? "";
}

/**
 * The issue or pull request `gh` just opened, read off the last line of its
 * output, or nothing when that line is not the URL of one.
 *
 * A number read loosely is worse than none: taken segment by segment, `3 files
 * changed` is issue 3, and a URL with trailing text yields a number while
 * keeping the text in the URL. Either way the pipeline goes on to wait for CI
 * on, comment on, or merge whatever issue happens to carry that number. So the
 * whole line has to be the URL, matched as strictly as {@link withCommentId}
 * matches a comment's, and anything else becomes the refusal both call sites
 * throw.
 *
 * Only the path shape is matched — host, owner, repo, the kind, the number — so
 * an Enterprise host reads the same as github.com without being named here.
 *
 * A pull request's ref is the same shape as an issue's, so one reader serves
 * both call sites.
 */
function refFromOutput(stdout: string): IssueRef | undefined {
  const url = lastLine(stdout);
  const match = ISSUE_OR_PR_URL.exec(url);
  return match ? { number: Number(match[1]), url } : undefined;
}

/**
 * A comment's id, read out of its URL, or nothing when the URL carries none.
 *
 * GitHub's REST API edits comments by a numeric id that `gh issue view` does not
 * report — its `id` is the GraphQL node id — and `gh issue comment` reports
 * nothing but a URL. The URL is the one handle both halves agree on, so both go
 * through here.
 *
 * Unlike the native relations this adapter refuses to guess, a missing id
 * decides nothing: it costs an edit, never a Ticket. So it is reported as
 * missing rather than thrown, and the one caller that needs to edit posts a
 * fresh comment instead.
 */
function withCommentId(url: string): { id?: string } {
  const id = COMMENT_ID.exec(url);
  return id ? { id: id[1] as string } : {};
}

/**
 * A missing dependency summary is an error, not an unblocked Ticket.
 *
 * Defaulting it to zero would put every blocked Ticket on the Frontier and
 * merge it, silently, on a GitHub that does not report the field. ADR-0003
 * trusts native relations only, so no answer has to mean no Run.
 */
function openBlockers(issue: RawCandidate): number {
  const blocked = issue.issue_dependencies_summary?.blocked_by;
  if (typeof blocked !== "number") {
    throw new Error(
      `#${issue.number} came back without issue_dependencies_summary.blocked_by, ` +
        "so its open blockers cannot be read; agent-pipeline trusts GitHub's " +
        "native dependencies only (ADR-0003)",
    );
  }
  return blocked;
}

/**
 * The two native relations the guards read, and neither may be guessed.
 *
 * A missing one is an error for the reason {@link openBlockers} refuses a
 * missing dependency summary: reading it as zero would hand every Spec to an
 * implement Stage and take every body-only blocker at its word (ADR-0003).
 */
function relations(issue: RawIssue): Pick<Issue, "subIssues" | "blockedBy"> {
  const missing = [
    typeof issue.subIssuesSummary?.total === "number" ? "" : "subIssuesSummary.total",
    issue.blockedBy === undefined ? "blockedBy" : "",
  ].filter((field) => field !== "");

  if (missing.length > 0) {
    throw new Error(
      `#${issue.number} came back without ${missing.join(" or ")}, so whether it ` +
        "is a Spec and what blocks it cannot be read; agent-pipeline trusts " +
        "GitHub's native relations only (ADR-0003)",
    );
  }
  return {
    subIssues: issue.subIssuesSummary?.total as number,
    blockedBy: (issue.blockedBy?.nodes ?? []).map((blocker) => blocker.number),
  };
}

/** `pending` means "ask again"; everything else is an answer. */
function readCi(result: Execution): CiReading | "pending" {
  if (/no checks reported/i.test(result.stderr)) return { state: "none" };

  let runs: CiCheck[];
  try {
    runs = JSON.parse(result.stdout) as CiCheck[];
  } catch {
    if (result.exitCode !== 0) return { state: "none" };
    throw new Error(`could not read gh pr checks output: ${result.output.trim()}`);
  }

  if (runs.length === 0) return { state: "none" };

  const failed = runs.filter((run) => run.bucket === "fail" || run.bucket === "cancel");
  if (failed.length > 0) {
    return {
      state: "failed",
      summary: failed
        .map((run) => `${run.name} ${run.bucket === "cancel" ? "cancelled" : "failed"}`)
        .join(", "),
      failed,
    };
  }
  if (runs.some((run) => run.bucket === "pending")) return "pending";
  return { state: "passed" };
}

/**
 * The Actions job id behind a check's link, or nothing when the check does not
 * report from one. An external app's check has a link of its own shape and no
 * log `gh` can read, which is a reason to skip it and never a reason to fail.
 */
function actionsJobId(link: string | undefined): string | undefined {
  const match = link === undefined ? null : ACTIONS_JOB_URL.exec(link);
  return match ? (match[1] as string) : undefined;
}

/**
 * The end of a log, under a fixed cap, saying what it left out.
 *
 * The tail is the part worth carrying: a runner prints the assertion or the
 * stack that ended the job last, under however much setup noise came first.
 */
function tail(log: string): string {
  const lines = log.split("\n");
  let kept = lines.slice(-MAX_LOG_LINES);
  while (kept.length > 1 && kept.join("\n").length > MAX_LOG_CHARS) kept = kept.slice(1);

  const text = kept.join("\n");
  const omitted = lines.length - kept.length;

  // A single line longer than the whole cap keeps its own tail: the error is at
  // the end of it. Its own start is cut too, which the count alone would not say.
  if (text.length > MAX_LOG_CHARS) {
    const earlier = omitted > 0 ? `${omitted} earlier lines and the start of this one` : "the start of this line";
    return `… (${earlier} omitted)\n${text.slice(-MAX_LOG_CHARS)}`;
  }
  return omitted > 0 ? `… (${omitted} earlier lines omitted)\n${text}` : text;
}
