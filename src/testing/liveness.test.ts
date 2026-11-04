import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { alive, goneSoon } from "./liveness.js";

/** The first line a child prints, as a pid. */
function firstPid(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    child.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
  });
}

describe("whether a process is alive", () => {
  it("is yes for one that is running", () => {
    const sleeper = spawn("sleep", ["30"]);
    try {
      expect(alive(sleeper.pid ?? 0)).toBe(true);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("is yes for one that is stopped", async () => {
    const sleeper = spawn("sleep", ["30"]);
    try {
      process.kill(sleeper.pid ?? 0, "SIGSTOP");
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(alive(sleeper.pid ?? 0)).toBe(true);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("is no for one that has exited and been reaped", async () => {
    const quick = spawn("true");
    await new Promise((resolve) => quick.once("exit", resolve));

    expect(alive(quick.pid ?? 0)).toBe(false);
  });

  it("is no for a zombie, which can still be signalled", async () => {
    // `sleep 0` exits at once, and the shell has become `sleep 30` by then,
    // which never waits on it: it stays a zombie until `sleep 30` goes.
    const parent = spawn("/bin/sh", ["-c", "sleep 0 & echo $!; exec sleep 30"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      const zombie = await firstPid(parent);

      expect(await goneSoon(zombie)).toBe(true);
      expect(() => process.kill(zombie, 0)).not.toThrow();
    } finally {
      parent.kill("SIGKILL");
    }
  });
});
