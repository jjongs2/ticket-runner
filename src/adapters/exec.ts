import { spawn } from "node:child_process";
import { type Mark, killTree } from "./process-tree.js";

export interface Execution {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved, as a human would see them in a terminal. */
  output: string;
  /**
   * Whether `timeoutMs` killed the child, which the exit code alone cannot
   * say: 124 is what the kill is reported as, and a command is free to exit
   * 124 on its own. Asking the run is the only honest answer.
   */
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  /** Run through the shell, for user-supplied Check commands. */
  shell?: boolean;
  timeoutMs?: number;
  /**
   * How long a command killed at `timeoutMs` has between SIGTERM and SIGKILL.
   * `KILL_GRACE_MS` unless a test needs it shorter.
   */
  killGraceMs?: number;
  /** Variables merged over the environment the child inherits, not replacing it. */
  extraEnv?: Record<string, string>;
  /**
   * A variable set over `extraEnv`, whose value nothing else on the Host
   * carries. A kill at `timeoutMs` also takes every process still carrying it,
   * which reaches what the child started after its parent has exited.
   */
  mark?: Mark;
  /**
   * Called with each chunk the child prints on that stream, as it arrives, so
   * a caller that saves the output has it before the child exits. A sink runs
   * inside the stream's handler: one that throws takes this process down.
   */
  onStdout?: (chunk: string) => void;
  /** As `onStdout`, for what the child prints on stderr. */
  onStderr?: (chunk: string) => void;
}

/**
 * How long a child's pipes are read after the child itself is gone. A
 * descendant that inherited them can hold them open for as long as it likes,
 * so what the child printed has to be collected on a clock rather than waited
 * for. Long enough that a pipe's worth of buffered output always arrives.
 *
 * What the clock gives up: everything the child itself wrote is complete,
 * because its own output is in the pipe buffer by the time it exits, but a
 * descendant's is collected only while the child lives and during this window
 * after it. Later than that it is dropped by design, in exchange for a call
 * that always settles.
 */
const DRAIN_MS = 100;

/**
 * How long a command killed at its time limit, and everything it started, has
 * to end on SIGTERM before SIGKILL. Long enough for a session to write out what
 * it holds, short enough that the Ticket is not held up waiting.
 */
const KILL_GRACE_MS = 5_000;

/**
 * How a child process is run. Adapters take one so tests can hand them
 * recorded output instead of spawning anything.
 */
export type RunProcess = (
  command: string,
  args: string[],
  options: ExecOptions,
) => Promise<Execution>;

/** Run a child process to completion. Never throws on a non-zero exit. */
export function exec(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<Execution> {
  return new Promise((resolve, reject) => {
    const { mark } = options;
    const extraEnv =
      mark === undefined ? options.extraEnv : { ...options.extraEnv, [mark.name]: mark.value };
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(extraEnv === undefined ? {} : { env: { ...process.env, ...extraEnv } }),
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let output = "";
    let killed = false;
    let settled = false;
    let limit: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    let killing: Promise<void> | undefined;

    /** The child itself is gone. Only a descendant can still hold its pipes. */
    const hasExited = () =>
      child.exitCode !== null || child.signalCode !== null;

    /** Let go of the clocks, and of read ends nobody may ever close. */
    const stopWaiting = () => {
      settled = true;
      clearTimeout(limit);
      clearTimeout(drain);
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const finish = () => {
      if (settled) return;
      stopWaiting();
      const execution = {
        exitCode: killed ? 124 : (child.exitCode ?? 1),
        stdout,
        stderr,
        output,
        timedOut: killed,
      };
      // A killed command is reported once what it started is gone too, so the
      // caller never works beside what is left of it.
      if (killing === undefined) resolve(execution);
      else void killing.then(() => resolve(execution));
    };

    /** Keep reading for a moment, then stop waiting on the pipes for good. */
    const drainThenFinish = () => {
      drain ??= setTimeout(finish, DRAIN_MS);
    };

    if (options.timeoutMs !== undefined) {
      limit = setTimeout(() => {
        // A child that already exited is past killing: its own exit started
        // the drain, and its own exit code is the honest one to report.
        if (hasExited()) return;
        killed = true;
        if (child.pid === undefined) child.kill("SIGKILL");
        else {
          const graceMs = options.killGraceMs ?? KILL_GRACE_MS;
          killing = killTree(child.pid, graceMs, mark === undefined ? {} : { mark });
        }
      }, options.timeoutMs);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      output += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      output += chunk;
      options.onStderr?.(chunk);
    });

    child.on("error", (error) => {
      if (settled) return;
      stopWaiting();
      reject(error);
    });
    // However the child ended, its pipes are read on a clock from here on.
    child.on("exit", drainThenFinish);
    // The usual ending, and the quicker one: nothing outlived the child, so
    // its pipes reach EOF and there is nothing left to wait for.
    child.on("close", finish);
  });
}

/** Run a child process and throw when it fails. */
export async function execOrThrow(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<Execution> {
  return throwOnFailure(command, args, await exec(command, args, options));
}

/** Turn a non-zero exit into an error naming the command and its output. */
export function throwOnFailure(
  command: string,
  args: string[],
  result: Execution,
): Execution {
  if (result.exitCode !== 0) {
    throw new Error(
      `\`${command} ${args.join(" ")}\` exited ${result.exitCode}\n${result.output.trim()}`,
    );
  }
  return result;
}
