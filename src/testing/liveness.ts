import { alive } from "../adapters/liveness.js";

/**
 * Whether a process a test killed is gone, judged as the kill itself judges it
 * (`src/adapters/liveness.ts`): a zombie counts as gone.
 *
 * Scaffolding the tests are built from rather than a word the pipeline uses, so
 * it is not in `GLOSSARY.md`.
 */

export { alive };

/**
 * Asks {@link alive} until it says no, for about a second: a killed process
 * takes a moment to go.
 */
export async function goneSoon(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 20; tries += 1) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * A script that starts `sleep <seconds>` leading a group of its own, prints its
 * pid, and then blocks its event loop for 30 s, so it never reaps it: once that
 * `sleep` exits, it stays a zombie still in its group.
 */
export function leaveGroupLeader(seconds: string): string {
  return `
    const { spawn } = require("node:child_process");
    const leader = spawn("sleep", ["${seconds}"], { detached: true, stdio: "ignore" });
    process.stdout.write(leader.pid + "\\n", () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
    });
  `;
}
