import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API_KEY_ENV_VAR, type Credential } from "../credential.js";
import {
  type AgentPreflight,
  type AgentRunner,
  SKILLS_PLUGIN,
  type StageFailure,
  type StageRequest,
  type StageResult,
} from "../ports/agent-runner.js";
import { STAGE_ENV_VAR } from "../stage-guard.js";
import { type Execution, type RunProcess, exec } from "./exec.js";
import type { Mark } from "./process-tree.js";

export interface ClaudeAgentRunnerOptions {
  binary?: string;
  run?: RunProcess;
  /** Whether a file is on the Host, asked of the Stage's shell. */
  exists?: (path: string) => boolean;
}

/**
 * The shell a Stage's commands run in. The Host user's own may be zsh, which
 * aborts the whole command line on a glob that matches nothing or a word that
 * starts with `=`, so the session would spend turns finding out why.
 */
const STAGE_SHELL = "/bin/bash";

/**
 * The Session mark: a variable every Stage carries at a value no other Stage
 * session shares, and every process it starts inherits. A Stage killed at its
 * time limit is killed with every process still carrying its value, whoever
 * their parent is by then.
 */
const SESSION_ENV_VAR = "TICKET_RUNNER_SESSION";

/**
 * The tools that act beyond a Stage's worktree and its session: a cloud
 * routine, a scheduled prompt, a notification, a wakeup after the Stage has
 * ended, a workflow of further agents. Nothing a Stage is asked to do needs one.
 */
const DISALLOWED_TOOLS = [
  "CronCreate",
  "CronDelete",
  "RemoteTrigger",
  "PushNotification",
  "ScheduleWakeup",
  "Workflow",
];

/**
 * How long one preflight question may take. Generous for a CLI printing its
 * own version, and short enough that `init` cannot hang on a binary that never
 * answers.
 */
const PREFLIGHT_TIMEOUT_MS = 60_000;

/** The final `result` event of a stream-json run, as far as we rely on it. */
interface ResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  num_turns?: number;
  result?: unknown;
  structured_output?: unknown;
  /**
   * Why the session's loop stopped. `api_error` is a request the API answered
   * with an error, or never answered, after the CLI's own retries ran out.
   */
  terminal_reason?: string;
  /**
   * The HTTP status of the API error that ended the session, when one did. The
   * CLI prints `null` for a request that never got an answer.
   */
  api_error_status?: number | null;
}

/**
 * The `system/init` event a stream-json run opens with, as far as we rely on
 * it: what the session says it is billed to.
 */
interface InitEvent {
  type: "system";
  subtype?: string;
  apiKeySource?: unknown;
}

/**
 * A `rate_limit_event` of a stream-json run: the CLI's own word on where the
 * subscription stands, printed as each request's answer comes back.
 */
interface RateLimitEvent {
  type: "rate_limit_event";
  /** `resetsAt` is when the limit resets, in seconds since the epoch. */
  rate_limit_info?: { status?: string; resetsAt?: number };
}

/**
 * One `claude -p` child process per Stage (ADR-0002).
 *
 * Thin on purpose: it builds the command line, saves everything the session
 * produced, and classifies how the session ended. It makes no decisions.
 */
export class ClaudeAgentRunner implements AgentRunner {
  private readonly binary: string;
  private readonly runProcess: RunProcess;
  private readonly exists: (path: string) => boolean;

  constructor(options: ClaudeAgentRunnerOptions = {}) {
    this.binary = options.binary ?? "claude";
    this.runProcess = options.run ?? exec;
    this.exists = options.exists ?? existsSync;
  }

  /**
   * What `claude` says about itself: that it can be run at all, and that the
   * plugin the Stages drive is installed.
   *
   * Every failure is an answer rather than an error — no binary, a CLI too old
   * to list its plugins, a non-zero exit — because the whole point of asking is
   * to put a line in the `init` report for the human who has to fix it.
   */
  async preflight(): Promise<AgentPreflight> {
    const version = await this.ask(["--version"]);
    if (version?.exitCode !== 0) return { runs: false, plugin: false };

    const plugins = await this.ask(["plugin", "list"]);
    const listed = plugins?.exitCode === 0 && plugins.stdout.includes(SKILLS_PLUGIN);
    return { runs: true, plugin: listed };
  }

  /** One preflight question, or nothing when `claude` could not be started. */
  private async ask(args: string[]): Promise<Execution | undefined> {
    try {
      return await this.runProcess(this.binary, args, { timeoutMs: PREFLIGHT_TIMEOUT_MS });
    } catch {
      return undefined;
    }
  }

  private async spawn(
    request: StageRequest,
    args: string[],
    env: Record<string, string>,
    session: Mark,
    log: StageLog,
  ): Promise<Execution> {
    try {
      return await this.runProcess(this.binary, args, {
        cwd: request.cwd,
        timeoutMs: request.maxMinutes * 60_000,
        extraEnv: env,
        ...(request.credential === "subscription" ? { unsetEnv: [API_KEY_ENV_VAR] } : {}),
        mark: session,
        onStdout: log.appendStdout,
        onStderr: log.appendStderr,
      });
    } catch (error) {
      return spawnFailure(error);
    }
  }

  async run(request: StageRequest): Promise<StageResult> {
    const args = buildArgs(request);
    const session = { name: SESSION_ENV_VAR, value: randomUUID() };
    const env = this.stageEnv(request, session);
    const commandLine = quoteCommand(request.credential, env, this.binary, args);
    const startedAt = Date.now();

    // Started before the child, so a Run killed mid-Stage still leaves the
    // command line and everything printed so far behind.
    const log = startStageLog(request, commandLine, process.env[API_KEY_ENV_VAR]);
    const execution = await this.spawn(request, args, env, session, log);

    const events = parseEvents(execution.stdout);
    log.close(execution, events);

    const results = events.filter(isResultEvent);
    const failure = classify(request, execution, events);
    const structured = request.jsonSchema === undefined ? undefined : structuredOutput(results);
    const turns = countTurns(results);
    const resetsAt = failure === "rate-limited" ? limitResetsAt(events) : undefined;
    const apiKeySource = keySource(events);

    return {
      ok: failure === undefined,
      ...(failure === undefined ? {} : { failure }),
      ...(structured === undefined ? {} : { result: structured }),
      commandLine,
      transcriptPath: log.transcriptPath,
      ...(turns === undefined ? {} : { turns }),
      ...(resetsAt === undefined ? {} : { limitResetsAt: resetsAt }),
      ...(apiKeySource === undefined ? {} : { apiKeySource }),
      // The clock is the runner's own. A session that woke for a background
      // agent reports one `duration_ms` per waking, and the time it spent
      // waiting for that agent belongs to none of them.
      durationMs: Date.now() - startedAt,
    };
  }

  /** What a Stage's environment carries beyond the one it inherits. */
  private stageEnv(request: StageRequest, session: Mark): Record<string, string> {
    return {
      // The Stage mark the CLI refuses on, so the session cannot nest a Run.
      [STAGE_ENV_VAR]: request.stage,
      // Two Lanes in the same Stage share the Stage mark, never this one.
      [session.name]: session.value,
      // The Host user's memory is about their own projects, not the Target.
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      // Where the Host has no bash, its own shell is still better than none.
      ...(this.exists(STAGE_SHELL) ? { CLAUDE_CODE_SHELL: STAGE_SHELL } : {}),
    };
  }
}

/**
 * A session that spawns a background agent ends its main turn with a `result`
 * event, then wakes once per finished agent and ends each waking with another.
 * Every later event counts only its own waking, so a Stage's turns are the sum
 * over all of them.
 */
function countTurns(results: ResultEvent[]): number | undefined {
  const counted = results.filter((result) => result.num_turns !== undefined);
  if (counted.length === 0) return undefined;
  return counted.reduce((sum, result) => sum + (result.num_turns ?? 0), 0);
}

/** A session that could not even start still has to leave a trace behind. */
async function spawnFailure(error: unknown): Promise<Execution> {
  const message = `ticket-runner could not start the Stage: ${(error as Error).message}\n`;
  return { exitCode: 1, stdout: "", stderr: message, output: message, timedOut: false };
}

function buildArgs(request: StageRequest): string[] {
  const args = [
    "--print",
    request.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    // Nobody is watching, so anything that would prompt is denied instead.
    "--permission-prompts",
    "none",
    "--permission-mode",
    request.permissionMode,
    // Without `--mcp-config`, this leaves the session no MCP server at all,
    // the claude.ai connectors of the Host user's account included.
    "--strict-mcp-config",
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
    "--model",
    request.model,
    // Always passed, like the model: a Stage's logged command line is what a
    // human pastes back, so neither may be left to the host's own default.
    "--effort",
    request.effort,
    "--max-turns",
    String(request.maxTurns),
  ];
  if (request.jsonSchema !== undefined) {
    args.push("--json-schema", JSON.stringify(request.jsonSchema));
  }
  return args;
}

/** The Stage's four files, written from the moment the Stage starts. */
interface StageLog {
  transcriptPath: string;
  appendStdout: (chunk: string) => void;
  appendStderr: (chunk: string) => void;
  /** Reconcile the output files with the finished child, then transcribe it. */
  close: (execution: Execution, events: unknown[]) => void;
}

/**
 * What stands in a Stage's files for the Host's API key, wherever the session
 * printed it: an `--api-key` Stage that runs `env` would otherwise put the key
 * in a transcript, which reaches the Target's remote with a hand-off.
 */
const REDACTED_KEY = `<${API_KEY_ENV_VAR}>`;

/**
 * Put the Stage's command line on disk and empty its output files, before
 * anything is spawned. Chunks are appended as they arrive rather than saved at
 * the end, so the files hold what the session printed even when nobody is left
 * alive to write them (#12). The transcript is the one derivation that has to
 * wait: it is parsed out of the stdout the session has finished printing.
 */
function startStageLog(
  request: StageRequest,
  commandLine: string,
  /** The Host's API key, whose value no file of the Stage may carry. */
  key: string | undefined,
): StageLog {
  mkdirSync(request.logDir, { recursive: true });
  const path = (suffix: string) => join(request.logDir, `${request.stage}.${suffix}`);
  const redact = (text: string) =>
    key === undefined || key === "" ? text : text.replaceAll(key, REDACTED_KEY);

  writeFileSync(path("command"), `${commandLine}\n`);
  // Emptied up front, so a Stage never appends to output from an earlier one.
  writeFileSync(path("stdout"), "");
  writeFileSync(path("stderr"), "");

  const appended = { stdout: 0, stderr: 0 };
  // The tail of each stream that may be the start of a key the next chunk
  // finishes. It stays off disk until that chunk shows it is not, so a Run
  // killed between the two chunks leaves no part of the key behind.
  const heldBack = { stdout: "", stderr: "" };
  // Appending happens inside the child's stream handler, where a throw would
  // take the whole Run down. A write that fails is left to `close` to redo.
  const append = (suffix: "stdout" | "stderr") => (chunk: string) => {
    try {
      const text = redact(heldBack[suffix] + chunk);
      const held = keyPrefixAtEnd(text, key);
      heldBack[suffix] = text.slice(text.length - held);
      appendFileSync(path(suffix), text.slice(0, text.length - held));
      appended[suffix] += chunk.length;
    } catch {
      // Nothing is lost: the chunk is still part of the Execution.
    }
  };

  return {
    transcriptPath: path("transcript.jsonl"),
    appendStdout: append("stdout"),
    appendStderr: append("stderr"),
    close: (execution, events) => {
      // Whatever the appends missed — a failed write, or a process runner that
      // delivered no chunks at all — is written back whole here, so a Stage
      // that ran to the end always has its full output on disk. Where the
      // Host has a key, both are written back whole whatever was appended,
      // which also puts the tail held back from the last chunk on disk.
      const keyed = key !== undefined && key !== "";
      if (keyed || appended.stdout !== execution.stdout.length) {
        writeFileSync(path("stdout"), redact(execution.stdout));
      }
      if (keyed || appended.stderr !== execution.stderr.length) {
        writeFileSync(path("stderr"), redact(execution.stderr));
      }
      writeFileSync(
        path("transcript.jsonl"),
        redact(
          events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""),
        ),
      );
    },
  };
}

/**
 * How many characters at the end of `text` could be the start of `key`, so a
 * key split across two chunks is redacted once the second arrives.
 */
function keyPrefixAtEnd(text: string, key: string | undefined): number {
  if (key === undefined || key === "") return 0;
  for (let length = Math.min(key.length - 1, text.length); length > 0; length--) {
    if (text.endsWith(key.slice(0, length))) return length;
  }
  return 0;
}

function parseEvents(stdout: string): unknown[] {
  const events: unknown[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Anything the CLI printed outside the stream stays in the stdout file.
    }
  }
  return events;
}

function isResultEvent(event: unknown): event is ResultEvent {
  return isEvent(event, "result");
}

function isInitEvent(event: unknown): event is InitEvent {
  return isEvent(event, "system") && (event as InitEvent).subtype === "init";
}

/**
 * What the session said it was billed to: the first init event's word on it.
 * A waking for a background agent is the same session on the same credential.
 */
function keySource(events: unknown[]): string | undefined {
  const source = events.find(isInitEvent)?.apiKeySource;
  return typeof source === "string" ? source : undefined;
}

function isRateLimitEvent(event: unknown): event is RateLimitEvent {
  return isEvent(event, "rate_limit_event");
}

function isEvent(event: unknown, type: string): boolean {
  return (
    typeof event === "object" && event !== null && (event as { type?: unknown }).type === type
  );
}

function classify(
  request: StageRequest,
  execution: Execution,
  events: unknown[],
): StageFailure | undefined {
  const results = events.filter(isResultEvent);
  // How the session ended is what its last event says; see `structuredOutput`
  // for why the last event is not where the rest of the answer is.
  const result = results.at(-1);

  if (execution.timedOut) return "timed-out";

  if (result?.subtype === "error_max_turns") return "turn-capped";

  // A session's failure is read from how it ended, never from what it talked
  // about: a Ticket about rate limits mentions them hundreds of times and
  // still succeeds.
  const failed = execution.exitCode !== 0 || result?.is_error === true || result === undefined;
  if (failed) {
    // Before the rate limit, whose wording the spend limit's message matches.
    if (outOfBudget(result)) return "out-of-budget";
    if (rateLimited(execution, events, result)) return "rate-limited";
    if (transientApiFailure(result)) return "api-error";
    return "nonzero-exit";
  }
  // A schema the Stage answered with nothing is only a failure where the
  // structured output was the point of the Stage; see `resultRequired`.
  if (
    request.jsonSchema !== undefined &&
    request.resultRequired !== false &&
    structuredOutput(results) === undefined
  ) {
    return "invalid-result";
  }
  return undefined;
}

/**
 * Whether a session that failed was refused because its API key's organization
 * is out of credit, or its workspace reached the spend limit set in the
 * Console. Both are a 400, as a malformed request is, and the spend limit's
 * `error` is `unknown`, so the message is what tells them apart: either
 * wording of the credit balance, or the workspace's usage limits.
 */
function outOfBudget(result: ResultEvent | undefined): boolean {
  if (result?.api_error_status !== 400) return false;
  return /credit balance is too low|workspace API usage limits/i.test(String(result.result ?? ""));
}

/**
 * Whether a session that failed was stopped by the rate limit: the
 * subscription's, or the API's on a Stage run on a key.
 *
 * The CLI says so in three places, and any one of them is enough: the `result`
 * event carries the API's 429, a `rate_limit_event` reports the request
 * `rejected`, or the message it printed names the limit. The message is read
 * last because it is the least stable of the three: its wording has already
 * moved from "usage limit" to "session limit" once, and a Run that only knew
 * the old wording handed off every Ticket it reached instead of releasing the
 * first. A `rate_limit_event` that merely warns is not a stop: a session near
 * the limit prints those and finishes.
 */
function rateLimited(
  execution: Execution,
  events: unknown[],
  result: ResultEvent | undefined,
): boolean {
  if (result?.api_error_status === 429) return true;
  if (events.some(rejected)) return true;
  const text = [result?.subtype ?? "", String(result?.result ?? ""), execution.stderr].join(" ");
  return /usage limit|session limit|rate limit|rate_limit/i.test(text);
}

/** A `rate_limit_event` that says the request was refused, not merely warned about. */
function rejected(event: unknown): event is RateLimitEvent {
  return isRateLimitEvent(event) && event.rate_limit_info?.status === "rejected";
}

/**
 * When the limit that stopped a session resets, ISO-8601: the last rejecting
 * event's word on it, or nothing when no rejecting event carried one.
 */
function limitResetsAt(events: unknown[]): string | undefined {
  const resetsAt = events.filter(rejected).at(-1)?.rate_limit_info?.resetsAt;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return undefined;
  return new Date(resetsAt * 1000).toISOString();
}

/**
 * Whether a session that failed, and was not rate-limited, was stopped by the
 * API failing on its own side: an overloaded or broken server, a 5xx, or a
 * request that never got an answer at all, which the CLI reports without a
 * status. Asked only after {@link rateLimited}, because a 429 ends the session
 * with the same `terminal_reason`. The CLI has already retried each of these by
 * the time it gives up, so the session is not worth retrying in place either.
 * Any other status — a prompt the API refused, say — is the session's own.
 */
function transientApiFailure(result: ResultEvent | undefined): boolean {
  if (result?.terminal_reason !== "api_error") return false;
  const status = result.api_error_status;
  return status === undefined || status === null || (status >= 500 && status <= 599);
}

/**
 * The Stage's structured output, from the last `result` event that carries one.
 *
 * The session answers the schema when its main turn ends, and may answer it
 * again from a waking for a background agent, once a review it spawned has
 * come back. The later answer is the one it stands by: sessions repeat every
 * Note they keep and add the ones the review turned up, so keeping the first
 * would drop those. A waking that answers nothing ends with an event that
 * carries no structured output, and that erases no earlier answer, which is why
 * reading only the last event would not do either.
 */
function structuredOutput(results: ResultEvent[]): unknown {
  for (const result of results.toReversed()) {
    const output = structuredOutputOf(result);
    if (output !== undefined) return output;
  }
  return undefined;
}

/**
 * One event's structured output: the dedicated field when the CLI provides it,
 * otherwise whatever JSON the session left in `result`.
 */
function structuredOutputOf(result: ResultEvent): unknown {
  if (result.structured_output !== undefined && result.structured_output !== null) {
    return result.structured_output;
  }
  if (typeof result.result === "object" && result.result !== null) return result.result;
  if (typeof result.result !== "string") return undefined;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(result.result);
  const candidate = (fenced?.[1] ?? result.result).trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Shell-quote the command so a human can paste it back into a terminal, with
 * the Stage's environment in front of it so the reproduction is exact.
 *
 * How the environment differed from the Host's leads it: a subscription Stage
 * ran without the Host's key, which `env -u` removes again, and an API-key
 * Stage ran on it, which is named and left for the shell to fill in. Its value
 * is never written: command files reach the Target's remote with a hand-off.
 */
function quoteCommand(
  credential: Credential,
  extraEnv: Record<string, string>,
  binary: string,
  args: string[],
): string {
  const assignments = Object.entries(extraEnv).map(([name, value]) => `${name}=${value}`);
  const differed =
    credential === "subscription"
      ? `env -u ${API_KEY_ENV_VAR}`
      : `${API_KEY_ENV_VAR}="$${API_KEY_ENV_VAR}"`;
  const quoted = [...assignments, binary, ...args]
    .map((part) => (/^[\w./:=-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`))
    .join(" ");
  return `${differed} ${quoted}`;
}
