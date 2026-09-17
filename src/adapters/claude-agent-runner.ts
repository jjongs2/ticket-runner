import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentRunner,
  StageFailure,
  StageRequest,
  StageResult,
} from "../ports/agent-runner.js";
import { STAGE_ENV_VAR } from "../stage-guard.js";
import { type Execution, type RunProcess, exec } from "./exec.js";

export interface ClaudeAgentRunnerOptions {
  binary?: string;
  run?: RunProcess;
}

/** The final `result` event of a stream-json run, as far as we rely on it. */
interface ResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  num_turns?: number;
  duration_ms?: number;
  result?: unknown;
  structured_output?: unknown;
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

    log.close(execution, parseEvents(execution.stdout));

    const events = parseEvents(execution.stdout);
    const result = events.findLast(isResultEvent);
    const failure = classify(request, execution, result);
    const structured = request.jsonSchema === undefined ? undefined : structuredOutput(result);

    return {
      ok: failure === undefined,
      ...(failure === undefined ? {} : { failure }),
      ...(structured === undefined ? {} : { result: structured }),
      commandLine,
      transcriptPath: log.transcriptPath,
      ...(result?.num_turns === undefined ? {} : { turns: result.num_turns }),
      durationMs: result?.duration_ms ?? Date.now() - startedAt,
    };
  }
}

/** A session that could not even start still has to leave a trace behind. */
async function spawnFailure(error: unknown): Promise<Execution> {
  const message = `agent-pipeline could not start the Stage: ${(error as Error).message}\n`;
  return { exitCode: 1, stdout: "", stderr: message, output: message };
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
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { type?: unknown }).type === "result"
  );
}

function classify(
  request: StageRequest,
  execution: Execution,
  result: ResultEvent | undefined,
): StageFailure | undefined {
  // 124 is what the wall-clock kill in `exec` reports.
  if (execution.exitCode === 124) return "timed-out";

  if (result?.subtype === "error_max_turns") return "turn-capped";

  // A session's failure is read from how it ended, never from what it talked
  // about: a Ticket about rate limits mentions them hundreds of times and
  // still succeeds.
  const failed = execution.exitCode !== 0 || result?.is_error === true || result === undefined;
  if (failed) {
    const text = [result?.subtype ?? "", String(result?.result ?? ""), execution.stderr].join(
      " ",
    );
    if (/usage limit|rate limit|rate_limit/i.test(text)) return "rate-limited";
    return "nonzero-exit";
  }
  // A schema the Stage answered with nothing is only a failure where the
  // structured output was the point of the Stage; see `resultRequired`.
  if (
    request.jsonSchema !== undefined &&
    request.resultRequired !== false &&
    structuredOutput(result) === undefined
  ) {
    return "invalid-result";
  }
  return undefined;
}

/**
 * The Stage's structured output: the dedicated field when the CLI provides it,
 * otherwise whatever JSON the session left in `result`.
 */
function structuredOutput(result: ResultEvent | undefined): unknown {
  if (result === undefined) return undefined;
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
