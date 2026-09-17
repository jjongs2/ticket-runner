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
  env?: NodeJS.ProcessEnv;
  /** Called with each chunk as it arrives, for live transcripts. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/** Run a child process to completion. Never throws on a non-zero exit. */
export function exec(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<Execution> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
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
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      output += chunk;
      options.onStderr?.(chunk);
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
  const result = await exec(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `\`${command} ${args.join(" ")}\` exited ${result.exitCode}\n${result.output.trim()}`,
    );
  }
  return result;
}
