import type { Credential } from "../credential.js";

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
 * How hard a Stage thinks, as `claude --effort` takes it, from the cheapest to
 * the most thorough. The Target's dial for trading a Stage's cost against how
 * much of a Ticket it gets through.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type Effort = (typeof EFFORT_LEVELS)[number];

/**
 * Why a Stage did not finish cleanly. `rate-limited`, `api-error` and
 * `out-of-budget` are singled out because the pipeline releases a claim rather
 * than blaming the Ticket for any of them: the rate limit, the API failing on
 * its side after the CLI had given up retrying it, and the API key's
 * organization out of credit or its workspace past its spend limit.
 */
export type StageFailure =
  | "rate-limited"
  | "api-error"
  | "out-of-budget"
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
  effort: Effort;
  maxTurns: number;
  maxMinutes: number;
  permissionMode: PermissionMode;
  /**
   * What the session is billed to: the subscription, with the Host's API key
   * kept out of its environment, or that key.
   */
  credential: Credential;
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
  /**
   * When the subscription rate limit resets, ISO-8601, as the event that
   * rejected the request said. Present only on a `rate-limited` Stage, and only
   * when the CLI said.
   */
  limitResetsAt?: string;
  /**
   * What the session said it was billed to, as its `system/init` event's
   * `apiKeySource` names it: `none` for the subscription login,
   * `ANTHROPIC_API_KEY`, `apiKeyHelper` and so on for a key. Absent where the
   * session printed no such event.
   */
  apiKeySource?: string;
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
