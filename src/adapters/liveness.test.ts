import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { goneSoon, leaveGroupLeader } from "../testing/liveness.js";
import { alive, groupAlive } from "./liveness.js";

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

      // Asked until it says no, since `sleep 0` may not have exited yet.

      expect(await goneSoon(zombie)).toBe(true);
      expect(() => process.kill(zombie, 0)).not.toThrow();
    } finally {
      parent.kill("SIGKILL");
    }
  });
});

describe("whether a process group is alive", () => {
  it("is yes for one with a member that is running", () => {
    const leader = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      expect(groupAlive(leader.pid ?? 0)).toBe(true);
    } finally {
      leader.kill("SIGKILL");
    }
  });

  it("is no for one whose only member is a zombie, though it can still be signalled", async () => {
    const parent = spawn("node", ["-e", leaveGroupLeader("0.3")], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      const zombie = await firstPid(parent);

      expect(await goneSoon(zombie)).toBe(true);
      expect(groupAlive(zombie)).toBe(false);
      expect(() => process.kill(-zombie, 0)).not.toThrow();
    } finally {
      parent.kill("SIGKILL");
    }
  });
});
