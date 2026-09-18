/**
 * One Claude Code session per Stage (ADR-0002).
 *
 * The orchestrator hands over a fully built prompt and the limits the Stage
 * must respect; the adapter owns the child process and the transcript on disk.
 */

export type StageName = "implement" | "verify" | "fix" | "conflict";

/**
 * The permission modes a Stage can run under. Only the modes that can actually
 * do work unattended: `plan` and the prompting modes would guarantee a no-op.
 */
export const PERMISSION_MODES = ["auto", "acceptEdits", "bypassPermissions"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

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
  permissionMode: PermissionMode;
  /** Where the command line, stdout, stderr and transcript are written. */
  logDir: string;
  /** When set, the Stage is asked for structured output matching this schema. */
  jsonSchema?: unknown;
  /**
   * Whether a Stage that emitted no structured output has failed. Defaults to
   * true.
   *
   * It is the verify Stage's Verdict that makes it true there: a session that
   * graded nothing has done none of its job. A schema that only carries Notes
   * is a side channel the Stage may have had nothing to put in, and failing a
   * Ticket over an empty one would be failing it for finding nothing.
   */
  resultRequired?: boolean;
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

/**
 * The plugin whose skills the Stages drive (ADR-0002). A Target whose machine
 * does not have it installed gets an implement Stage with no skill behind it.
 */
export const SKILLS_PLUGIN = "mattpocock-skills";

/**
 * What `init` can find out about the agent side of a Target's machine without
 * starting a Stage. Both are reported to the human and neither is repaired:
 * installing a CLI and a plugin is the one part of setup only they can do.
 */
export interface AgentPreflight {
  /** Whether the agent CLI could be run at all. */
  runs: boolean;
  /**
   * Whether {@link SKILLS_PLUGIN} is installed. False whenever the CLI could
   * not be asked, since an answer nobody could get is not a yes.
   */
  plugin: boolean;
}

export interface AgentRunner {
  run(request: StageRequest): Promise<StageResult>;
  /**
   * Ask the agent CLI about itself. Reports rather than throws: every way it
   * can go wrong — no binary, a CLI that cannot list its plugins — is a line
   * in the `init` report and never an error that stops setup.
   */
  preflight(): Promise<AgentPreflight>;
}
