import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { killTree, markedInPs, processesMarked } from "./process-tree.js";

const MARK = { name: "TICKET_RUNNER_SESSION", value: "3f2c9a10-killed" };

/** Whether a process of that id is still there to be signalled. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A killed process lingers as a zombie until its new parent reaps it. */
async function goneSoon(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 20; tries += 1) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/** The first line a child prints, as a pid. */
function firstPid(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    child.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
  });
}

describe("the processes carrying a mark", () => {
  it("are read from ps -wwE output, as one NAME=value word of a line", () => {
    // In the shape BSD `ps -A -wwE -o pid=,command=` prints: the environment
    // follows the command's arguments on the same line.
    const output = [
      "    1 /sbin/launchd",
      "  412 /usr/libexec/logd",
      " 5123 -zsh TERM_PROGRAM=Apple_Terminal SHELL=/bin/zsh HOME=/Users/me",
      ` 5130 node /usr/local/bin/claude --print x TICKET_RUNNER_STAGE=implement ${MARK.name}=${MARK.value} PATH=/usr/bin`,
      ` 5200 sleep 30 PATH=/usr/bin:/bin ${MARK.name}=${MARK.value}`,
      ` 5201 sleep 30 ${MARK.name}=${MARK.value}-other HOME=/Users/me`,
      ` 5202 sleep 30 ${MARK.name}_OLD=${MARK.value}`,
      ` 5300 node /usr/local/bin/claude --print y ${MARK.name}=4b7d0e21-kept PATH=/usr/bin`,
      "",
    ].join("\n");

    expect(markedInPs(output, MARK)).toEqual([5130, 5200]);
  });

  it.skipIf(!existsSync("/proc"))("are read from /proc where there is one, and no others", () => {
    const mark = { name: "TEST_MARK", value: `proc-${process.pid}` };
    const marked = spawn("sleep", ["5"], { env: { ...process.env, [mark.name]: mark.value } });
    const bystander = spawn("sleep", ["5"]);

    const found = processesMarked(mark);

    marked.kill("SIGKILL");
    bystander.kill("SIGKILL");
    expect(found).toEqual([marked.pid]);
  });
});

describe("a kill that cannot read any environment", () => {
  it("still takes the command's descendants and the groups they lead", async () => {
    const script = `
      const { spawn } = require("node:child_process");
      const leader = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
      process.stdout.write(leader.pid + "\\n");
      setTimeout(() => {}, 30_000);
    `;
    const command = spawn("node", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    const leader = await firstPid(command);

    await killTree(command.pid ?? 0, 300, {
      mark: MARK,
      findMarked: () => {
        throw new Error("no /proc and no ps");
      },
    });

    expect(await goneSoon(command.pid ?? 0)).toBe(true);
    expect(await goneSoon(leader)).toBe(true);
  });
});
