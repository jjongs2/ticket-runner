import type {
  ChecksOutcome,
  CreatePullRequest,
  Issue,
  LabelSpec,
  PullRequestRef,
  Tracker,
} from "../ports/tracker.js";
import type { RunProcess } from "./claude-agent-runner.js";
import { type Execution, exec } from "./exec.js";

export interface GhTrackerOptions {
  run?: RunProcess;
  cwd?: string;
  baseBranch?: string;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** One entry of `gh pr checks --json`. */
interface CheckRun {
  name: string;
  bucket: string;
}

/**
 * The GitHub-backed {@link Tracker}, spoken through the `gh` CLI so it reuses
 * the repo's own auth and conventions.
 *
 * Thin on purpose: argument building and output parsing, no decisions.
 */
export class GhTracker implements Tracker {
  private readonly run_: RunProcess;
  private readonly cwd: string | undefined;
  private readonly baseBranch: string;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: GhTrackerOptions = {}) {
    this.run_ = options.run ?? exec;
    this.cwd = options.cwd;
    this.baseBranch = options.baseBranch ?? "main";
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async currentUser(): Promise<string> {
    const { stdout } = await this.gh(["api", "user", "--jq", ".login"]);
    return stdout.trim();
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

  async getIssue(number: number): Promise<Issue> {
    const { stdout } = await this.gh([
      "issue",
      "view",
      String(number),
      "--json",
      "number,title,url,body,labels,assignees,comments",
    ]);
    const raw = JSON.parse(stdout) as {
      number: number;
      title: string;
      url: string;
      body: string;
      labels: { name: string }[];
      assignees: { login: string }[];
      comments: { body: string }[];
    };
    return {
      number: raw.number,
      title: raw.title,
      url: raw.url,
      body: raw.body ?? "",
      labels: raw.labels.map((label) => label.name),
      assignees: raw.assignees.map((assignee) => assignee.login),
      comments: raw.comments.map((comment) => comment.body),
    };
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

  async comment(number: number, body: string): Promise<void> {
    await this.gh(["issue", "comment", String(number), "--body", body]);
  }

  async createPullRequest(pr: CreatePullRequest): Promise<PullRequestRef> {
    const args = [
      "pr",
      "create",
      "--base",
      this.baseBranch,
      "--head",
      pr.head,
      "--title",
      pr.title,
      "--body",
      pr.body,
    ];
    if (pr.draft) args.push("--draft");

    const { stdout } = await this.gh(args);
    const url = stdout.trim().split("\n").at(-1) ?? "";
    const number = Number.parseInt(url.split("/").at(-1) ?? "", 10);
    if (!Number.isInteger(number)) {
      throw new Error(`could not read a pull request number from gh output: ${stdout}`);
    }
    return { number, url };
  }

  async convertPullRequestToDraft(number: number): Promise<void> {
    await this.gh(["pr", "ready", String(number), "--undo"]);
  }

  /**
   * Poll the PR's checks until they settle or the timeout runs out. A PR with
   * no checks is reported as such, never as a pass.
   */
  async waitForChecks(number: number, timeoutMs: number): Promise<ChecksOutcome> {
    const deadline = this.now() + timeoutMs;

    for (;;) {
      const result = await this.gh(
        ["pr", "checks", String(number), "--json", "name,bucket,state"],
        { allowFailure: true },
      );

      const outcome = readChecks(result);
      if (outcome !== "pending") return outcome;
      if (this.now() >= deadline) return { state: "timed-out" };
      await this.sleep(this.pollIntervalMs);
    }
  }

  async squashMerge(number: number): Promise<void> {
    await this.gh(["pr", "merge", String(number), "--squash"]);
  }

  private editIssue(number: number, flag: string, value: string) {
    return this.gh(["issue", "edit", String(number), flag, value]);
  }

  private async gh(
    args: string[],
    options: { allowFailure?: boolean } = {},
  ): Promise<Execution> {
    const result = await this.run_("gh", args, {
      ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
    });
    if (result.exitCode !== 0 && !options.allowFailure) {
      throw new Error(`\`gh ${args.join(" ")}\` exited ${result.exitCode}\n${result.output.trim()}`);
    }
    return result;
  }
}

/** `pending` means "ask again"; everything else is an answer. */
function readChecks(result: Execution): ChecksOutcome | "pending" {
  if (/no checks reported/i.test(result.stderr)) return { state: "none" };

  let runs: CheckRun[];
  try {
    runs = JSON.parse(result.stdout) as CheckRun[];
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
    };
  }
  if (runs.some((run) => run.bucket === "pending")) return "pending";
  return { state: "passed" };
}
