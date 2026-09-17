import { spawn } from "node:child_process";

export interface Execution {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved, as a human would see them in a terminal. */
  output: string;
}

export interface ExecOptions {
  cwd?: string;
  /** Run through the shell, for user-supplied Check commands. */
  shell?: boolean;
  timeoutMs?: number;
  /** Variables merged over the environment the child inherits, not replacing it. */
  extraEnv?: Record<string, string>;
}

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
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.extraEnv === undefined
        ? {}
        : { env: { ...process.env, ...options.extraEnv } }),
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let output = "";
    let timedOut = false;

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      output += chunk;
    });

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr,
        output,
      });
    });
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
