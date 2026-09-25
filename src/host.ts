/**
 * Which kind of Host a Run executes on (CONTEXT.md), decided here and nowhere
 * else, so every part of the pipeline that behaves differently in the cloud
 * asks the same question the same way.
 */

/** A workstation that outlives the Run, or a Claude Code cloud session's VM. */
export type HostKind = "workstation" | "cloud";

/** What a Claude Code cloud session sets, to `true`, in every process it starts. */
export const CLOUD_ENV_VAR = "CLAUDE_CODE_REMOTE";

/**
 * The Host the environment says this process runs on.
 *
 * Takes the environment so either answer can be tested without `process.env`.
 * Only the value the cloud session sets counts: anything else, the variable
 * unset included, is a workstation, which is what every Host was before
 * ADR-0008.
 */
export function hostKind(env: Record<string, string | undefined>): HostKind {
  return env[CLOUD_ENV_VAR] === "true" ? "cloud" : "workstation";
}
