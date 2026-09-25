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
import { DEFAULT_CI_GRACE_MINUTES } from "../config.js";
import { highestVersion } from "../version-number.js";
import { type Execution, type RunProcess, exec, throwOnFailure } from "./exec.js";

export interface GhTrackerOptions {
  run?: RunProcess;
  cwd?: string;
  pollIntervalMs?: number;
  /**
   * How long "no checks yet" counts as pending after the wait starts. The
   * Target's `ciGraceMinutes`, in the unit the poll works in.
   */
  checksGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * One issue as the REST API reports it, in the fields the pipeline reads. The
 * issue list, the dependency list and a single issue all answer in this shape.
 */
interface RawIssue {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  /** `open` or `closed`. */
  state?: string;
  labels: { name: string }[];
  assignees: { login: string }[] | null;
  /** Present on pull requests only; GitHub lists them as issues too. */
  pull_request?: unknown;
  sub_issues_summary?: { total?: number };
}

/** One entry of an issue's REST comment list. */
interface RawComment {
  id?: number;
  body: string | null;
}

/** One issue GitHub records as blocking another, and whether it still does. */
interface Blocker {
  number: number;
  open: boolean;
}

/** One entry of `gh release list --json`, in the three fields a Version needs. */
interface RawRelease {
  tagName: string;
  isDraft: boolean;
  isPrerelease: boolean;
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
    this.checksGraceMs = options.checksGraceMs ?? DEFAULT_CI_GRACE_MINUTES * 60_000;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /**
   * Whether `gh` can reach GitHub as somebody, which is whether REST will say
   * who the current user is.
   *
   * Not `gh auth status`: on a cloud Host it calls the proxy's placeholder
   * token invalid while every REST call a Run makes works (ADR-0008).
   *
   * The failure is the answer here, so this is the one call that does not
   * throw on one: `init` reports it as a line rather than as a crash.
   */
  async authenticated(): Promise<boolean> {
    try {
      const { exitCode } = await this.gh(["api", "user", "--jq", ".login"], {
        allowFailure: true,
      });
      return exitCode === 0;
    } catch {
      // `gh` itself is not on the PATH, which is as unauthenticated as it gets.
      return false;
    }
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

  /**
   * The tag of the highest Version published on `repository` as a Release.
   *
   * Every failure is the same answer — no answer — because nothing the caller
   * does with it may stop a Run: a rate limit, a repository nobody can see, a
   * `gh` that is not installed. The list is asked for rather than GitHub's own
   * `latest`, which is the newest by date: a patch cut on an old branch after a
   * minor would otherwise be reported as the Version to upgrade to. A hundred
   * of them is every Version this tool is likely to have, and they arrive
   * newest first, so the highest is among them wherever the count lands.
   */
  async latestVersionTag(repository: string): Promise<string | undefined> {
    try {
      const { exitCode, stdout } = await this.gh(
        [
          "release",
          "list",
          "--repo",
          repository,
          "--json",
          "tagName,isDraft,isPrerelease",
          "--limit",
          "100",
        ],
        { allowFailure: true },
      );
      if (exitCode !== 0) return undefined;
      const releases = JSON.parse(stdout) as RawRelease[];
      return highestVersion(
        releases
          .filter((release) => !release.isDraft && !release.isPrerelease)
          .map((release) => release.tagName),
      )?.tag;
    } catch {
      return undefined;
    }
  }

  async listLabels(): Promise<string[]> {
    const labels = await this.list<{ name: string }>("repos/{owner}/{repo}/labels");
    return labels.map((label) => label.name);
  }

  async createLabel(label: LabelSpec): Promise<void> {
    await this.gh([
      "api",
      "--method",
      "POST",
      "repos/{owner}/{repo}/labels",
      "-f",
      `name=${label.name}`,
      "-f",
      `color=${label.color}`,
      "-f",
      `description=${label.description}`,
    ]);
  }

  /**
   * Turn squash merging on, naming that one field and no other.
   *
   * The repository's own PATCH endpoint takes each merge method separately, so
   * a repository that also allows merge commits keeps allowing them.
   */
  async enableSquashMerge(): Promise<void> {
    await this.gh([
      "api",
      "--method",
      "PATCH",
      "repos/{owner}/{repo}",
      "-F",
      "allow_squash_merge=true",
    ]);
  }

  /**
   * One issue, with its comments and the two native relations the guards read:
   * how many sub-issues it has, and what GitHub says blocks it.
   *
   * Three REST calls, because the issue itself carries neither its comments nor
   * its blockers, only a count of each.
   */
  async getIssue(number: number): Promise<Issue> {
    const { stdout } = await this.gh(["api", `repos/{owner}/{repo}/issues/${number}`]);
    const raw = JSON.parse(stdout) as RawIssue;
    const comments = await this.list<RawComment>(`repos/{owner}/{repo}/issues/${number}/comments`);
    const blockers = await this.blockers(number);
    return {
      number: raw.number,
      title: raw.title,
      url: raw.html_url,
      body: raw.body ?? "",
      closed: raw.state === "closed",
      labels: raw.labels.map((label) => label.name),
      assignees: (raw.assignees ?? []).map((assignee) => assignee.login),
      comments: comments.map((comment) => ({ ...withId(comment), body: comment.body ?? "" })),
      subIssues: subIssues(raw),
      blockedBy: blockers.map((blocker) => blocker.number),
    };
  }

  /**
   * Open an issue, and read its number back out of what REST answers with.
   *
   * GitHub creates a label the Target does not have rather than refusing the
   * issue, so a missing label is `init`'s to catch, not this call's.
   */
  async createIssue(issue: CreateIssue): Promise<IssueRef> {
    const { stdout } = await this.gh([
      "api",
      "--method",
      "POST",
      "repos/{owner}/{repo}/issues",
      "-f",
      `title=${issue.title}`,
      "-f",
      `body=${issue.body}`,
      ...issue.labels.flatMap((label) => ["-f", `labels[]=${label}`]),
    ]);
    const created = JSON.parse(stdout) as Partial<RawIssue>;
    if (typeof created.number !== "number" || typeof created.html_url !== "string") {
      throw new Error(`could not read an issue number from gh output: ${stdout}`);
    }
    return { number: created.number, url: created.html_url };
  }

  /**
   * The open issues carrying `label`, straight from the REST issue list, each
   * with its open blockers counted off its own dependency list.
   *
   * Not off the list's `issue_dependencies_summary`: the summary lags the list,
   * so a blocker added a moment ago would be missed and its Ticket merged ahead
   * of it. That costs a call per candidate, and native dependencies are the
   * only blocker source the pipeline trusts (ADR-0003).
   */
  async listCandidates(label: string): Promise<Candidate[]> {
    const issues = await this.list<RawIssue>("repos/{owner}/{repo}/issues", [
      "-f",
      "state=open",
      "-f",
      `labels=${label}`,
    ]);

    const candidates: Candidate[] = [];
    for (const issue of issues.filter((issue) => issue.pull_request === undefined)) {
      const blockers = await this.blockers(issue.number);
      candidates.push({
        number: issue.number,
        title: issue.title,
        assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
        openBlockers: blockers.filter((blocker) => blocker.open).length,
      });
    }
    return candidates;
  }

  async assign(number: number, user: string): Promise<void> {
    await this.gh([
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/issues/${number}/assignees`,
      "-f",
      `assignees[]=${user}`,
    ]);
  }

  async unassign(number: number, user: string): Promise<void> {
    await this.gh([
      "api",
      "--method",
      "DELETE",
      `repos/{owner}/{repo}/issues/${number}/assignees`,
      "-f",
      `assignees[]=${user}`,
    ]);
  }

  async addLabel(number: number, label: string): Promise<void> {
    await this.gh([
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/issues/${number}/labels`,
      "-f",
      `labels[]=${label}`,
    ]);
  }

  /**
   * Take a label off an issue, and take one it does not wear as already off.
   *
   * REST answers that with a 404 where `gh issue edit --remove-label` did
   * nothing, and a Ticket must not fail over a label somebody removed first.
   * Every other failure, a missing issue's 404 included, still throws.
   */
  async removeLabel(number: number, label: string): Promise<void> {
    const args = [
      "api",
      "--method",
      "DELETE",
      `repos/{owner}/{repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
    ];
    const result = await this.gh(args, { allowFailure: true });
    if (/Label does not exist/.test(result.output)) return;
    throwOnFailure("gh", args, result);
  }

  /** REST answers with the new comment, whose id is what it is edited by later. */
  async comment(number: number, body: string): Promise<IssueComment> {
    const { stdout } = await this.gh([
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/issues/${number}/comments`,
      "-f",
      `body=${body}`,
    ]);
    return { ...withId(JSON.parse(stdout) as RawComment), body };
  }

  /** Edit a comment in place, by the numeric id REST reported it with. */
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
    await this.gh([
      "api",
      "--method",
      "PATCH",
      `repos/{owner}/{repo}/issues/${number}`,
      "-f",
      `body=${body}`,
    ]);
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

  /**
   * The same command as the draft direction, without the flag that reverses it.
   *
   * `gh` warns and exits zero on a pull request that is already out of draft, so
   * the second pass a fix Stage buys asks this of a ready pull request for
   * nothing rather than failing the Ticket at `pr`.
   */
  async markPullRequestReady(number: number): Promise<void> {
    await this.gh(["pr", "ready", String(number)]);
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

  /**
   * The issues GitHub records as blocking `number`, open or closed, from the
   * issue's own dependency list.
   *
   * A blocker whose state did not come back counts as open: reading it as
   * closed would put a blocked Ticket on the Frontier (ADR-0003). A GitHub that
   * cannot list dependencies at all fails the call, which is no answer rather
   * than an empty one.
   */
  private async blockers(number: number): Promise<Blocker[]> {
    const blockers = await this.list<RawIssue>(
      `repos/{owner}/{repo}/issues/${number}/dependencies/blocked_by`,
    );
    return blockers.map((blocker) => ({
      number: blocker.number,
      open: blocker.state !== "closed",
    }));
  }

  /**
   * Every page of a REST list, as one array: `gh --paginate` joins the pages.
   * `--method GET` is spelled out because fields would otherwise make it a POST.
   */
  private async list<T>(path: string, fields: string[] = []): Promise<T[]> {
    const { stdout } = await this.gh([
      "api",
      "--paginate",
      "--method",
      "GET",
      path,
      "-F",
      "per_page=100",
      ...fields,
    ]);
    return JSON.parse(stdout) as T[];
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

/** The URL `gh pr create` prints, and the number it ends in. */
const PULL_REQUEST_URL = /^https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/(\d+)$/;

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
 * The pull request `gh` just opened, read off the last line of its output, or
 * nothing when that line is not the URL of one.
 *
 * A number read loosely is worse than none: taken segment by segment, `3 files
 * changed` is pull request 3, and a URL with trailing text yields a number
 * while keeping the text in the URL. Either way the pipeline goes on to wait
 * for CI on, comment on, or merge whatever happens to carry that number. So the
 * whole line has to be the URL, and anything else becomes the refusal the call
 * site throws.
 *
 * Only the path shape is matched — host, owner, repo, the kind, the number — so
 * an Enterprise host reads the same as github.com without being named here.
 */
function refFromOutput(stdout: string): PullRequestRef | undefined {
  const url = lastLine(stdout);
  const match = PULL_REQUEST_URL.exec(url);
  return match ? { number: Number(match[1]), url } : undefined;
}

/**
 * A comment's id, as the string {@link Tracker.updateComment} takes, or nothing
 * when REST reported none.
 *
 * Unlike the native relations this adapter refuses to guess, a missing id
 * decides nothing: it costs an edit, never a Ticket. So it is reported as
 * missing rather than thrown, and the one caller that needs to edit posts a
 * fresh comment instead.
 */
function withId(comment: RawComment): { id?: string } {
  return typeof comment.id === "number" ? { id: String(comment.id) } : {};
}

/**
 * How many native sub-issues an issue has, and it may not be guessed.
 *
 * Reading a missing summary as zero would hand every Spec to an implement
 * Stage (ADR-0003), so no answer is an error.
 */
function subIssues(issue: RawIssue): number {
  const total = issue.sub_issues_summary?.total;
  if (typeof total !== "number") {
    throw new Error(
      `#${issue.number} came back without sub_issues_summary.total, so whether ` +
        "it is a Spec cannot be read; agent-pipeline trusts GitHub's native " +
        "relations only (ADR-0003)",
    );
  }
  return total;
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
