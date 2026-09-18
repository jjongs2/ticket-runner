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
 * `output` follows what the child printed unless a test names it, the way a
 * real run's does — stdout and stderr in the order a single stream would have
 * carried them, which for a recording that sets one of them is that one.
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
