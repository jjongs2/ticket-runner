import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

export interface ClaudeAgentRunnerOptions {
  binary?: string;
  run?: RunProcess;
}

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
  /** The HTTP status of the API error that ended the session, when one did. */
  api_error_status?: number;
}

/**
 * A `rate_limit_event` of a stream-json run: the CLI's own word on where the
 * subscription stands, printed as each request's answer comes back.
 */
interface RateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info?: { status?: string };
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

  constructor(options: ClaudeAgentRunnerOptions = {}) {
    this.binary = options.binary ?? "claude";
    this.runProcess = options.run ?? exec;
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
    log: StageLog,
  ): Promise<Execution> {
    try {
      return await this.runProcess(this.binary, args, {
        cwd: request.cwd,
        timeoutMs: request.maxMinutes * 60_000,
        // The Stage mark the CLI refuses on, so the session cannot nest a Run.
        extraEnv: stageEnv(request),
        onStdout: log.appendStdout,
        onStderr: log.appendStderr,
      });
    } catch (error) {
      return spawnFailure(error);
    }
  }

  async run(request: StageRequest): Promise<StageResult> {
    const args = buildArgs(request);
    const commandLine = quoteCommand(stageEnv(request), this.binary, args);
    const startedAt = Date.now();

    // Started before the child, so a Run killed mid-Stage still leaves the
    // command line and everything printed so far behind.
    const log = startStageLog(request, commandLine);
    const execution = await this.spawn(request, args, log);

    const events = parseEvents(execution.stdout);
    log.close(execution, events);

    const results = events.filter(isResultEvent);
    const failure = classify(request, execution, events);
    const structured = request.jsonSchema === undefined ? undefined : structuredOutput(results);
    const turns = countTurns(results);

    return {
      ok: failure === undefined,
      ...(failure === undefined ? {} : { failure }),
      ...(structured === undefined ? {} : { result: structured }),
      commandLine,
      transcriptPath: log.transcriptPath,
      ...(turns === undefined ? {} : { turns }),
      // The clock is the runner's own. A session that woke for a background
      // agent reports one `duration_ms` per waking, and the time it spent
      // waiting for that agent belongs to none of them.
      durationMs: Date.now() - startedAt,
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
  const message = `agent-pipeline could not start the Stage: ${(error as Error).message}\n`;
  return { exitCode: 1, stdout: "", stderr: message, output: message, timedOut: false };
}

/** What a Stage's shell carries beyond the environment it inherits. */
function stageEnv(request: StageRequest): Record<string, string> {
  return { [STAGE_ENV_VAR]: request.stage };
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
    "--model",
    request.model,
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
 * Put the Stage's command line on disk and empty its output files, before
 * anything is spawned. Chunks are appended as they arrive rather than saved at
 * the end, so the files hold what the session printed even when nobody is left
 * alive to write them (#12). The transcript is the one derivation that has to
 * wait: it is parsed out of the stdout the session has finished printing.
 */
function startStageLog(request: StageRequest, commandLine: string): StageLog {
  mkdirSync(request.logDir, { recursive: true });
  const path = (suffix: string) => join(request.logDir, `${request.stage}.${suffix}`);

  writeFileSync(path("command"), `${commandLine}\n`);
  // Emptied up front, so a Stage never appends to output from an earlier one.
  writeFileSync(path("stdout"), "");
  writeFileSync(path("stderr"), "");

  const appended = { stdout: 0, stderr: 0 };
  // Appending happens inside the child's stream handler, where a throw would
  // take the whole Run down. A write that fails is left to `close` to redo.
  const append = (suffix: "stdout" | "stderr") => (chunk: string) => {
    try {
      appendFileSync(path(suffix), chunk);
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
      // that ran to the end always has its full output on disk.
      if (appended.stdout !== execution.stdout.length) {
        writeFileSync(path("stdout"), execution.stdout);
      }
      if (appended.stderr !== execution.stderr.length) {
        writeFileSync(path("stderr"), execution.stderr);
      }
      writeFileSync(
        path("transcript.jsonl"),
        events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""),
      );
    },
  };
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
    if (rateLimited(execution, events, result)) return "rate-limited";
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
 * Whether a session that failed was stopped by the subscription rate limit.
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
  const rejected = (event: unknown) =>
    isRateLimitEvent(event) && event.rate_limit_info?.status === "rejected";
  if (events.some(rejected)) return true;
  const text = [result?.subtype ?? "", String(result?.result ?? ""), execution.stderr].join(" ");
  return /usage limit|session limit|rate limit|rate_limit/i.test(text);
}

/**
 * The Stage's structured output, from whichever `result` event carries one.
 *
 * The session answers the schema when its main turn ends, which is the first
 * event; a waking for a background agent ends with an event that carries none.
 * Reading only the last event would drop a Verdict or the Notes over a review
 * the session had waited for.
 */
function structuredOutput(results: ResultEvent[]): unknown {
  for (const result of results) {
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
 */
function quoteCommand(
  extraEnv: Record<string, string>,
  binary: string,
  args: string[],
): string {
  const assignments = Object.entries(extraEnv).map(([name, value]) => `${name}=${value}`);
  return [...assignments, binary, ...args]
    .map((part) => (/^[\w./:=-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`))
    .join(" ");
}
