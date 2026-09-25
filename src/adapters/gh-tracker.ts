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
import { type HostKind, hostKind } from "../host.js";
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
  /**
   * The Host the Run is on, which only draft and ready depend on. Whatever the
   * environment says unless a test says otherwise.
   */
  host?: HostKind;
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

/** One entry of the REST release list, in the three fields a Version needs. */
interface RawRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
}

/** A pull request as REST reports it, in the fields the pipeline reads. */
interface RawPullRequest {
  number: number;
  html_url: string;
  /** The GraphQL id, which a workstation's draft and ready mutations take. */
  node_id: string;
  draft: boolean;
  head: { sha: string };
}

/** One check run on a commit, as the REST check-runs list reports it. */
interface RawCheckRun {
  name: string;
  /** `queued`, `in_progress`, `completed` and the like; only `completed` has a conclusion. */
  status: string;
  conclusion: string | null;
  /** Where the check reports; for an Actions job, the job's own page. */
  details_url?: string | null;
  html_url?: string | null;
}

/** One commit status, as the REST combined status reports it: the latest per context. */
interface RawStatus {
  context: string;
  /** `success`, `failure`, `error` or `pending`. */
  state: string;
  target_url?: string | null;
}

/**
 * The bucket `gh pr checks` sorted a check into, which is still the vocabulary
 * a reading is made of now that the checks come from REST.
 */
type Bucket = "pass" | "fail" | "cancel" | "skipping" | "pending";

/** One check on a pull request's head commit, a check run or a commit status alike. */
interface CiCheck {
  name: string;
  bucket: Bucket;
  /** Where the check reports; an Actions job's is the only one a log is behind. */
  link?: string;
}

/**
 * What one reading of the head commit's checks settled on, before any log is
 * fetched.
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
  private readonly host: HostKind;

  constructor(options: GhTrackerOptions = {}) {
    this.runProcess = options.run ?? exec;
    this.cwd = options.cwd;
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.checksGraceMs = options.checksGraceMs ?? DEFAULT_CI_GRACE_MINUTES * 60_000;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.host = options.host ?? hostKind(process.env);
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

  /**
   * Whatever the Target's `HEAD` points at, read off the repository through
   * REST: `gh repo view` asks GraphQL, which a cloud Host refuses (ADR-0008).
   */
  async defaultBranch(): Promise<string> {
    const { stdout } = await this.gh(["api", "repos/{owner}/{repo}", "--jq", ".default_branch"]);
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
   * newest first, so the highest is among them wherever the count lands: one
   * page, never every page.
   */
  async latestVersionTag(repository: string): Promise<string | undefined> {
    try {
      const { exitCode, stdout } = await this.gh(
        ["api", "--method", "GET", `repos/${repository}/releases`, "-F", "per_page=100"],
        { allowFailure: true },
      );
      if (exitCode !== 0) return undefined;
      const releases = JSON.parse(stdout) as RawRelease[];
      return highestVersion(
        releases
          .filter((release) => !release.draft && !release.prerelease)
          .map((release) => release.tag_name),
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
    await this.rest("POST", "repos/{owner}/{repo}/labels", [
      `name=${label.name}`,
      `color=${label.color}`,
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
    await this.rest("PATCH", "repos/{owner}/{repo}", [], { typed: ["allow_squash_merge=true"] });
  }

  /**
   * Read off the repository itself. GitHub leaves the field out for a caller
   * who may not change it, which is read as off: a Run cannot count on it.
   */
  async deletesBranchOnMerge(): Promise<boolean> {
    const { stdout } = await this.gh(["api", "repos/{owner}/{repo}", "--jq", ".delete_branch_on_merge"]);
    return stdout.trim() === "true";
  }

  async enableDeleteBranchOnMerge(): Promise<void> {
    await this.rest("PATCH", "repos/{owner}/{repo}", [], { typed: ["delete_branch_on_merge=true"] });
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
      comments: comments.map((comment) => ({ ...withCommentId(comment), body: comment.body ?? "" })),
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
    const { stdout } = await this.rest("POST", "repos/{owner}/{repo}/issues", [
      `title=${issue.title}`,
      `body=${issue.body}`,
      ...issue.labels.map((label) => `labels[]=${label}`),
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

  /**
   * Assign `user`, and refuse an assignment GitHub did not make.
   *
   * REST answers a user it cannot assign with the issue as it was and a
   * success, where `gh issue edit --add-assignee` failed. A Claim nobody can
   * see is worse than one that fails, so the answer is read back.
   */
  async assign(number: number, user: string): Promise<void> {
    const { stdout } = await this.rest(
      "POST",
      `repos/{owner}/{repo}/issues/${number}/assignees`,
      [`assignees[]=${user}`],
    );
    const assignees = (JSON.parse(stdout) as Partial<RawIssue>).assignees ?? [];
    if (!assignees.some((assignee) => assignee.login.toLowerCase() === user.toLowerCase())) {
      throw new Error(`GitHub did not assign ${user} to #${number}`);
    }
  }

  async unassign(number: number, user: string): Promise<void> {
    await this.rest("DELETE", `repos/{owner}/{repo}/issues/${number}/assignees`, [
      `assignees[]=${user}`,
    ]);
  }

  async addLabel(number: number, label: string): Promise<void> {
    await this.rest("POST", `repos/{owner}/{repo}/issues/${number}/labels`, [
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
    const path = `repos/{owner}/{repo}/issues/${number}/labels/${encodeURIComponent(label)}`;
    const result = await this.rest("DELETE", path, [], { allowFailure: true });
    if (/Label does not exist/.test(result.output)) return;
    throwOnFailure("gh", ["api", "--method", "DELETE", path], result);
  }

  /** REST answers with the new comment, whose id is what it is edited by later. */
  async comment(number: number, body: string): Promise<IssueComment> {
    const { stdout } = await this.rest("POST", `repos/{owner}/{repo}/issues/${number}/comments`, [
      `body=${body}`,
    ]);
    return { ...withCommentId(JSON.parse(stdout) as RawComment), body };
  }

  /** Edit a comment in place, by the numeric id REST reported it with. */
  async updateComment(id: string, body: string): Promise<void> {
    await this.rest("PATCH", `repos/{owner}/{repo}/issues/comments/${id}`, [`body=${body}`]);
  }

  async updateIssueBody(number: number, body: string): Promise<void> {
    await this.rest("PATCH", `repos/{owner}/{repo}/issues/${number}`, [`body=${body}`]);
  }

  /**
   * Open a pull request through REST, and read its number back out of the
   * answer rather than off anything printed.
   */
  async createPullRequest(pr: CreatePullRequest): Promise<PullRequestRef> {
    const { stdout } = await this.rest(
      "POST",
      "repos/{owner}/{repo}/pulls",
      [`base=${pr.base}`, `head=${pr.head}`, `title=${pr.title}`, `body=${pr.body}`],
      { typed: [`draft=${pr.draft}`] },
    );
    const created = JSON.parse(stdout) as Partial<RawPullRequest>;
    if (typeof created.number !== "number" || typeof created.html_url !== "string") {
      throw new Error(`could not read a pull request number from gh output: ${stdout}`);
    }
    return { number: created.number, url: created.html_url };
  }

  async convertPullRequestToDraft(number: number): Promise<void> {
    await this.setDraft(number, true);
  }

  /**
   * The draft direction reversed.
   *
   * A pull request already out of draft is left as it is, as `gh pr ready` left
   * it, so the second pass a fix Stage buys asks this of a ready pull request
   * for nothing rather than failing the Ticket at `pr`.
   */
  async markPullRequestReady(number: number): Promise<void> {
    await this.setDraft(number, false);
  }

  async updatePullRequestBody(number: number, body: string): Promise<void> {
    await this.rest("PATCH", `repos/{owner}/{repo}/pulls/${number}`, [`body=${body}`]);
  }

  /**
   * Poll the PR's CI until it settles or the timeout runs out. A PR with no
   * checks is reported as such, never as a pass.
   *
   * The checks are the head commit's check runs and commit statuses, which is
   * everything `gh pr checks` read through GraphQL.
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
      const reading = readCi(await this.checks(number));
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
   * The tail of each failing Actions job's log, or a line saying it could not
   * be had and where the job is.
   *
   * Evidence is worth a few extra calls and nothing more: a Ticket whose CI
   * really is red has a failure to report whether or not a log came back, so
   * every way the fetch can go wrong — a `gh` that fails or is not there, a
   * proxy that will not follow the log's redirect, an empty log — is reported
   * to the fix Stage as a log it has to go and look at rather than as an error.
   * A check that is not an Actions job has no log to fetch and yields nothing.
   *
   * The cap counts the jobs a log could be fetched for, not the red checks: a
   * PR whose external checks went red alongside one Actions job still gets the
   * one log there is. What it keeps out of a prompt is a whole matrix failing
   * a leg at a time, each leg with the same log.
   */
  private async failedJobLogs(failed: CiCheck[]): Promise<string> {
    const jobs = failed.flatMap((check) => {
      const job = actionsJobId(check.link);
      return job === undefined || check.link === undefined
        ? []
        : [{ name: check.name, job, link: check.link }];
    });

    const logs: string[] = [];
    for (const { name, job, link } of jobs.slice(0, MAX_LOG_JOBS)) {
      const log = await this.jobLog(job);
      logs.push(
        log === undefined
          ? `${name}\n(the log was unavailable; the job is at ${link})`
          : `${name}\n${tail(log)}`,
      );
    }
    return logs.join("\n\n");
  }

  /**
   * One Actions job's log through REST, up to the last line the runner marked
   * as an error, or nothing when there is no log to be had.
   *
   * REST gives the whole job where `gh run view --log-failed` gave the failed
   * steps, so what the post-job cleanup printed after the failure is cut off:
   * otherwise it would be the tail that is kept.
   */
  private async jobLog(job: string): Promise<string | undefined> {
    try {
      const result = await this.gh(["api", `repos/{owner}/{repo}/actions/jobs/${job}/logs`], {
        allowFailure: true,
      });
      if (result.exitCode !== 0) return undefined;
      const log = throughLastError(result.stdout).trim();
      return log === "" ? undefined : log;
    } catch {
      // `gh` itself could not be run. The failure still stands; the log does not.
      return undefined;
    }
  }

  /**
   * Squash-merge through REST, with the subject and body the pipeline composed
   * as the commit's title and message.
   */
  async squashMerge(number: number, commit: SquashCommit): Promise<void> {
    await this.rest("PUT", `repos/{owner}/{repo}/pulls/${number}/merge`, [
      "merge_method=squash",
      `commit_title=${commit.subject}`,
      `commit_message=${commit.body}`,
    ]);
  }

  /** One pull request, read through REST. */
  private async pullRequest(number: number): Promise<RawPullRequest> {
    const { stdout } = await this.gh(["api", `repos/{owner}/{repo}/pulls/${number}`]);
    return JSON.parse(stdout) as RawPullRequest;
  }

  /**
   * Put a pull request into draft or take it out, and leave one already there
   * as it is.
   *
   * The one call that depends on the Host: GitHub's REST API has no form of it,
   * so a workstation uses the GraphQL mutation `gh pr ready` used, and a cloud
   * Host, where GraphQL is refused, the proxy's own routes (ADR-0008). The
   * state is read first on either, which is also where GraphQL's id comes from.
   */
  private async setDraft(number: number, draft: boolean): Promise<void> {
    const pr = await this.pullRequest(number);
    if (pr.draft === draft) return;

    if (this.host === "cloud") {
      const route = draft ? "convert_to_draft" : "ready_for_review";
      await this.rest("POST", `repos/{owner}/{repo}/pulls/${number}/ccr/${route}`, []);
      return;
    }

    const mutation = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
    await this.gh([
      "api",
      "graphql",
      "-f",
      `query=mutation($id: ID!) { ${mutation}(input: {pullRequestId: $id}) { pullRequest { isDraft } } }`,
      "-f",
      `id=${pr.node_id}`,
    ]);
  }

  /**
   * Every check on a pull request's head commit — its check runs and its
   * commit statuses — or nothing when GitHub would not say, which reads as no
   * checks.
   *
   * The head is read afresh each time, as `gh pr checks` read it, so a failed
   * read costs one reading rather than the wait. Check runs come from the
   * `latest` filter REST applies by default, so a job re-run after failing
   * counts as its re-run, as `gh pr checks` counted it.
   */
  private async checks(number: number): Promise<CiCheck[] | undefined> {
    const pr = await this.gh(["api", `repos/{owner}/{repo}/pulls/${number}`], {
      allowFailure: true,
    });
    if (pr.exitCode !== 0) return undefined;
    const { sha } = (JSON.parse(pr.stdout) as RawPullRequest).head;
    const commit = `repos/{owner}/{repo}/commits/${sha}`;
    const runs = await this.wrappedList(`${commit}/check-runs`, "check_runs");
    const statuses = await this.wrappedList(`${commit}/status`, "statuses");
    if (runs === undefined || statuses === undefined) return undefined;
    return [
      ...(runs as RawCheckRun[]).map((run) => ({
        name: run.name,
        bucket: checkRunBucket(run),
        ...linked(run.details_url ?? run.html_url),
      })),
      ...(statuses as RawStatus[]).map((status) => ({
        name: status.context,
        bucket: statusBucket(status.state),
        ...linked(status.target_url),
      })),
    ];
  }

  /**
   * Every page of a list REST wraps in an object under `key`, one entry per
   * line as `--jq` prints them, or nothing when the call failed: `--paginate`
   * joins arrays, not the objects around them.
   */
  private async wrappedList(path: string, key: string): Promise<unknown[] | undefined> {
    const result = await this.gh([...pagedGet(path), "--jq", `.${key}[]`], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) return undefined;
    try {
      return result.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as unknown);
    } catch {
      throw new Error(`could not read the ${key} gh listed: ${result.output.trim()}`);
    }
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
   * One REST write, every field raw with `-f`, so a body is never read as a
   * file or a number whatever it starts with. The `typed` ones are the few
   * that must reach GitHub as a boolean, and go with `-F`.
   */
  private rest(
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    fields: string[],
    options: { allowFailure?: boolean; typed?: string[] } = {},
  ): Promise<Execution> {
    return this.gh(
      [
        "api",
        "--method",
        method,
        path,
        ...fields.flatMap((field) => ["-f", field]),
        ...(options.typed ?? []).flatMap((field) => ["-F", field]),
      ],
      options.allowFailure ? { allowFailure: true } : {},
    );
  }

  /**
   * Every page of a REST list, as one array: `gh --paginate` joins the pages.
   * `--method GET` is spelled out because fields would otherwise make it a POST.
   */
  private async list<T>(path: string, fields: string[] = []): Promise<T[]> {
    const { stdout } = await this.gh([...pagedGet(path), ...fields]);
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

/**
 * Every page of a REST list, a hundred at a time. `--method GET` is spelled
 * out because fields would otherwise make it a POST.
 */
function pagedGet(path: string): string[] {
  return ["api", "--paginate", "--method", "GET", path, "-F", "per_page=100"];
}

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

/**
 * A comment's id, as the string {@link Tracker.updateComment} takes, or nothing
 * when REST reported none.
 *
 * Unlike the native relations this adapter refuses to guess, a missing id
 * decides nothing: it costs an edit, never a Ticket. So it is reported as
 * missing rather than thrown, and the one caller that needs to edit posts a
 * fresh comment instead.
 */
function withCommentId(comment: RawComment): { id?: string } {
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

/**
 * `pending` means "ask again"; everything else is an answer. Checks GitHub
 * would not report read as none, as a failing `gh pr checks` did, so the grace
 * period still covers a wait that starts before the checks exist.
 */
function readCi(checks: CiCheck[] | undefined): CiReading | "pending" {
  if (checks === undefined || checks.length === 0) return { state: "none" };

  const failed = checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel");
  if (failed.length > 0) {
    return {
      state: "failed",
      summary: failed
        .map((check) => `${check.name} ${check.bucket === "cancel" ? "cancelled" : "failed"}`)
        .join(", "),
      failed,
    };
  }
  if (checks.some((check) => check.bucket === "pending")) return "pending";
  return { state: "passed" };
}

/**
 * A check run's bucket, as `gh pr checks` sorted it: by conclusion once it has
 * completed, and pending until then. A conclusion GitHub adds later is pending
 * too, which the timeout bounds, rather than a pass nobody saw.
 *
 * One departure: `startup_failure`, which `gh` left pending, is a failure. A
 * workflow that could not start never will, and waiting it out only turns a
 * red check into a timeout.
 */
function checkRunBucket(run: RawCheckRun): Bucket {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
      return "pass";
    case "skipped":
    case "neutral":
      return "skipping";
    case "cancelled":
      return "cancel";
    case "failure":
    case "timed_out":
    case "action_required":
    case "startup_failure":
      return "fail";
    default:
      return "pending";
  }
}

/** A commit status's bucket: `error` and `failure` are red, and `pending` is pending. */
function statusBucket(state: string): Bucket {
  if (state === "success") return "pass";
  if (state === "failure" || state === "error") return "fail";
  return "pending";
}

/** A check's link, left out rather than empty when GitHub reported none. */
function linked(url: string | null | undefined): { link?: string } {
  return url ? { link: url } : {};
}

/** Everything up to the last line an Actions runner marked `##[error]`, or all of it. */
function throughLastError(log: string): string {
  const lines = log.split("\n");
  const last = lines.findLastIndex((line) => line.includes("##[error]"));
  return last === -1 ? log : lines.slice(0, last + 1).join("\n");
}

/**
 * The Actions job id behind a check's link, or nothing when the check does not
 * report from one. An external app's check has a link of its own shape and no
 * log REST can give, which is a reason to skip it and never a reason to fail.
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
