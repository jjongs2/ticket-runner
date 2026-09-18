/**
 * Builders for the process runner's `Execution`.
 *
 * An adapter is tested by handing it a recorded run rather than spawning one,
 * so every adapter suite needs the same five fields filled in. They are spelled
 * out here and nowhere else: the next field `Execution` grows lands in one
 * place instead of in every suite that records a run.
 */

import type { Execution } from "../adapters/exec.js";

/**
 * A recorded run, successful unless the overrides say otherwise.
 *
 * `output` defaults to stdout followed by stderr rather than to nothing, so a
 * recording that sets one stream still carries what the child printed. A real
 * run interleaves the two and a recording cannot know that order, so a test
 * that needs both of them in `output` names it.
 */
export function execution(overrides: Partial<Execution> = {}): Execution {
  const run = { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...overrides };
  return { ...run, output: overrides.output ?? run.stdout + run.stderr };
}

/**
 * A run that failed, named by what it printed on stderr: the part such a test
 * is there for, since it is where an adapter reads the reason off.
 */
export function failedExecution(
  stderr: string,
  overrides: Partial<Execution> = {},
): Execution {
  return execution({ exitCode: 1, stderr, ...overrides });
}
