import { mkdirSync, writeFileSync } from "node:fs";
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

  private async spawn(request: StageRequest, args: string[]): Promise<Execution> {
    try {
      return await this.runProcess(this.binary, args, {
        cwd: request.cwd,
        timeoutMs: request.maxMinutes * 60_000,
        // The mark the CLI refuses on, so the session cannot start a nested Run.
        env: stageEnv(request),
      });
    } catch (error) {
      return spawnFailure(error);
    }
  }

  async run(request: StageRequest): Promise<StageResult> {
    const args = buildArgs(request);
    const commandLine = quoteCommand(request, this.binary, args);
    const startedAt = Date.now();

    const execution = await this.spawn(request, args);

    const events = parseEvents(execution.stdout);
    const transcriptPath = save(request, commandLine, execution, events);

    const result = events.findLast(isResultEvent);
    const failure = classify(request, execution, result);
    const structured = request.jsonSchema === undefined ? undefined : structuredOutput(result);

    return {
      ok: failure === undefined,
      ...(failure === undefined ? {} : { failure }),
      ...(structured === undefined ? {} : { result: structured }),
      commandLine,
      transcriptPath,
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

/** What the Stage's shell carries beyond the environment it inherits. */
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

/** Write the command line, stdout, stderr and transcript for this Stage. */
function save(
  request: StageRequest,
  commandLine: string,
  execution: Execution,
  events: unknown[],
): string {
  mkdirSync(request.logDir, { recursive: true });
  const transcriptPath = join(request.logDir, `${request.stage}.transcript.jsonl`);

  writeFileSync(join(request.logDir, `${request.stage}.command`), `${commandLine}\n`);
  writeFileSync(join(request.logDir, `${request.stage}.stdout`), execution.stdout);
  writeFileSync(join(request.logDir, `${request.stage}.stderr`), execution.stderr);
  writeFileSync(
    transcriptPath,
    events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""),
  );

  return transcriptPath;
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
function quoteCommand(request: StageRequest, binary: string, args: string[]): string {
  const env = Object.entries(stageEnv(request)).map(([name, value]) => `${name}=${value}`);
  return [...env, binary, ...args]
    .map((part) => (/^[\w./:=-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`))
    .join(" ");
}
