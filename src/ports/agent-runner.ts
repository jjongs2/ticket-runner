import type { Credential } from "../credential.js";

/**
 * One Claude Code session per Stage (ADR-0002).
 *
 * The orchestrator hands over a fully built prompt and the limits the Stage
 * must respect; the adapter owns the child process and the transcript on disk.
 */

/**
 * The Stages. `pr` revises the pull request's prose on a Ticket handed back
 * with commits since its hand-off, and runs nowhere else.
 */
export type StageName = "implement" | "verify" | "fix" | "conflict" | "pr";

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
  | "nonzero-exit"
  | "invalid-result";

export interface StageRequest {
  stage: StageName;
  prompt: string;
  /** The worktree the session runs in. */
  cwd: string;
  model: string;
  effort: Effort;
  /** The Stage's one limit: the session is killed when it runs past it. */
  maxMinutes: number;
  permissionMode: PermissionMode;
  /**
   * What the session is billed to: the subscription, with the Host's API key
   * kept out of its environment, or that key.
   */
  credential: Credential;
  /** Where the command line, the transcript of stdout, and stderr are written. */
  logDir: string;
  /**
   * Where {@link SKILLS_PLUGIN} is installed on the Host, as the Run's
   * {@link AgentPreflight} found it. The session loads nothing else from the
   * Host user's own scope, so this is how the plugin reaches it.
   */
  pluginDir: string;
  /** When set, the Stage is asked for structured output matching this schema. */
  jsonSchema?: unknown;
  /**
   * Whether a Stage that emitted no structured output has failed. Defaults to
   * true.
   *
   * It is the verify Stage's verdict that makes it true there: a session that
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
  /**
   * The main session's context when the Stage ended. Absent where the session
   * printed no `assistant` event of its own with any usage on it.
   */
  context?: StageContext;
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
  /**
   * What the CLI priced the session at, in dollars: the `total_cost_usd` of its
   * last `result` event. A session that woke for background agents repeats the
   * whole session's figure on every waking, so it is read once, never summed.
   * Absent where no `result` event carried one: a session a Stop killed, the
   * wall-clock limit stopped, or that crashed before it.
   */
  costUsd?: number;
  /**
   * Present, and true, when {@link costUsd} is only part of the session's:
   * the session went on past the last `result` event that gave a figure, and
   * was killed or crashed before it gave another, or the wall-clock limit
   * stopped it while it waited for a background agent.
   */
  costIncomplete?: true;
  /**
   * Present, and true, when one of the session's `rate_limit_event`s said it
   * was using the subscription's extra usage (`isUsingOverage`).
   */
  extraUsage?: true;
}

/**
 * How much context the main session held when its Stage ended, as its last
 * `assistant` event with any usage on it counted it: the input, cache-creation
 * and cache-read tokens summed. A subagent's events are not the main session's,
 * and the CLI's own rate-limit and API-error messages carry no usage at all.
 */
export interface StageContext {
  tokens: number;
  /** Present, and true, when the main session compacted at least once. */
  compacted?: true;
}

/**
 * The plugin whose skills the Stages drive (ADR-0002). A Target whose machine
 * does not have it installed gets an implement Stage with no skill behind it.
 */
export const SKILLS_PLUGIN = "mattpocock-skills";

/**
 * What `init` and a Run can find out about the agent side of a Target's machine
 * without starting a Stage. `init` reports both to the human and a Run refuses
 * to start without the plugin; neither is repaired: installing a CLI and a
 * plugin is the one part of setup only they can do.
 */
export interface AgentPreflight {
  /** Whether the agent CLI could be run at all. */
  runs: boolean;
  /**
   * Where {@link SKILLS_PLUGIN} is installed, which a Stage loads it from.
   * Absent where it is not installed, and whenever the CLI could not be asked,
   * since an answer nobody could get is not a yes.
   */
  pluginDir?: string;
}

export interface AgentRunner {
  run(request: StageRequest): Promise<StageResult>;
  /**
   * Ask the agent CLI about itself. Reports rather than throws: every way it
   * can go wrong — no binary, a CLI that cannot list its plugins — is a line
   * in the `init` report or a Run's refusal, never an error.
   */
  preflight(): Promise<AgentPreflight>;
}
