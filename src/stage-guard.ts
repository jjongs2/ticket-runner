/**
 * The Stage boundary: a Stage session may not run the pipeline it is building.
 *
 * Every Stage the AgentRunner starts carries the Stage mark, an environment
 * variable the child inherits, and the CLI refuses to do anything while it is
 * present. It is a tripwire against an honest mistake, not a sandbox — a
 * session that unsets the variable still gets through. The prompt guidance in
 * `prompts.ts` is what covers intent.
 */

/** The Stage mark: set by the AgentRunner to the name of the Stage it starts. */
export const STAGE_ENV_VAR = "AGENT_PIPELINE_STAGE";

/**
 * Why this invocation must not start, when the shell carries the Stage mark.
 * Takes the environment so the refusal can be tested without `process.env`.
 */
export function nestedRunRefusal(env: Record<string, string | undefined>): string | undefined {
  const mark = env[STAGE_ENV_VAR];
  if (mark === undefined) return undefined;

  // A blanked mark is still a mark; only an unset variable is a human's shell.
  const stage = mark.trim() === "" ? undefined : mark.trim();
  return [
    `Refusing to start: ${STAGE_ENV_VAR} is set${stage === undefined ? "" : ` to \`${stage}\``},`,
    `so this shell belongs to ${stage === undefined ? "a" : `the ${stage}`} Stage of a Run`,
    "that is already in progress.",
    "A Stage may not run the pipeline: doing so claims a Ticket on the live tracker,",
    "creates a second worktree and starts a nested Run.",
    "Exercise the pipeline through its tests and fakes instead.",
  ].join(" ");
}
