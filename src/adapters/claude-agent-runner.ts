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
      return spawnFailure(error, log);
    }
  }

  async run(request: StageRequest): Promise<StageResult> {
    const args = buildArgs(request);
    const commandLine = quoteCommand(stageEnv(request), this.binary, args);
    const startedAt = Date.now();

    // Opened before the child starts: a Run killed mid-Stage still leaves the
    // command line and everything printed so far behind.
    const log = openStageLog(request, commandLine);
    const execution = await this.spawn(request, args, log);

    const events = parseEvents(execution.stdout);
    log.writeTranscript(events);

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
async function spawnFailure(error: unknown, log: StageLog): Promise<Execution> {
  const message = `agent-pipeline could not start the Stage: ${(error as Error).message}\n`;
  log.appendStderr(message);
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

/** This Stage's four files, open for the whole Stage. */
interface StageLog {
  transcriptPath: string;
  appendStdout: (chunk: string) => void;
  appendStderr: (chunk: string) => void;
  writeTranscript: (events: unknown[]) => void;
}

/**
 * Put the Stage's command line on disk and open its output files, before
 * anything is spawned. Chunks are appended as they arrive rather than saved at
 * the end, so the files hold what the session printed even if nobody is left
 * alive to write them (#12). The transcript is the one derivation that has to
 * wait: it is parsed out of the stdout the session has finished printing.
 */
function openStageLog(request: StageRequest, commandLine: string): StageLog {
  mkdirSync(request.logDir, { recursive: true });
  const path = (suffix: string) => join(request.logDir, `${request.stage}.${suffix}`);

  writeFileSync(path("command"), `${commandLine}\n`);
  // Truncated up front, so a re-run of a Stage never appends to stale output.
  writeFileSync(path("stdout"), "");
  writeFileSync(path("stderr"), "");

  return {
    transcriptPath: path("transcript.jsonl"),
    appendStdout: (chunk) => appendFileSync(path("stdout"), chunk),
    appendStderr: (chunk) => appendFileSync(path("stderr"), chunk),
    writeTranscript: (events) =>
      writeFileSync(
        path("transcript.jsonl"),
        events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""),
      ),
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

  const text = [result?.subtype ?? "", String(result?.result ?? ""), execution.stderr].join(
    " ",
  );
  if (/usage limit|rate limit|rate_limit/i.test(text)) return "rate-limited";
  if (result?.subtype === "error_max_turns") return "turn-capped";
  if (execution.exitCode !== 0 || result?.is_error === true || result === undefined) {
    return "nonzero-exit";
  }
  if (request.jsonSchema !== undefined && structuredOutput(result) === undefined) {
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
