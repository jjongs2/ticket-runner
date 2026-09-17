/**
 * One Claude Code session per Stage (ADR-0002).
 *
 * The orchestrator hands over a fully built prompt and the limits the Stage
 * must respect; the adapter owns the child process and the transcript on disk.
 */

export type StageName = "implement" | "verify" | "fix";

/**
 * Why a Stage did not finish cleanly. `rate-limited` is singled out because the
 * pipeline releases a claim rather than blaming the Ticket for it.
 */
export type StageFailure =
  | "rate-limited"
  | "timed-out"
  | "turn-capped"
  | "nonzero-exit"
  | "invalid-result";

export interface StageRequest {
  stage: StageName;
  prompt: string;
  /** The worktree the session runs in. */
  cwd: string;
  model: string;
  maxTurns: number;
  maxMinutes: number;
  permissionMode: string;
  /** Where the command line, stdout, stderr and transcript are written. */
  logDir: string;
  /** When set, the Stage must emit structured output matching this schema. */
  jsonSchema?: unknown;
}

export interface StageResult {
  ok: boolean;
  failure?: StageFailure;
  /** The structured output, present only when `jsonSchema` was requested. */
  result?: unknown;
  /** The exact command line, reproducible by hand. */
  commandLine: string;
  transcriptPath: string;
  turns?: number;
  durationMs: number;
}

export interface AgentRunner {
  run(request: StageRequest): Promise<StageResult>;
}
