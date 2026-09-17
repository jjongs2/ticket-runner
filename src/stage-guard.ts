/**
 * The Stage boundary: a Stage session may not run the pipeline it is building.
 *
 * Every Stage the AgentRunner starts is marked with an environment variable the
 * child inherits, and the CLI refuses to do anything while that mark is present.
 * It is a tripwire against an honest mistake, not a sandbox — a session that
 * unsets the variable still gets through. The prompt guidance covers intent.
 */

/** Set by the AgentRunner on every Stage it spawns, to that Stage's name. */
export const STAGE_ENV_VAR = "AGENT_PIPELINE_STAGE";

/**
 * Why this invocation must not start, when the shell belongs to a Stage.
 * Takes the environment so the refusal can be tested without `process.env`.
 */
export function nestedRunRefusal(env: Record<string, string | undefined>): string | undefined {
  const stage = env[STAGE_ENV_VAR]?.trim();
  if (stage === undefined || stage === "") return undefined;

  return [
    `Refusing to start: ${STAGE_ENV_VAR}=${stage} is set, so this shell belongs to the`,
    `${stage} Stage of a Run that is already in progress.`,
    "A Stage may not run the pipeline: doing so claims a Ticket on the live tracker,",
    "creates a second worktree and starts a nested Run.",
    "Exercise the pipeline through its tests and fakes instead.",
  ].join(" ");
}
