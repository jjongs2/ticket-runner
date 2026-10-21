import { describe, expect, it } from "vitest";
import { exec } from "./exec.js";

/** Printing one variable is enough to see what the child actually inherited. */
function printEnv(name: string): [string, string[]] {
  return ["node", ["-e", `process.stdout.write(String(process.env.${name}))`]];
}

/**
 * A child that prints on one stream and hands that same stream to a descendant,
 * the way a session that starts a background process does. The descendant
 * outlives the test that spawns it.
 */
function leaveDescendantHolding(stream: "stdout" | "stderr"): string {
  const stdio =
    stream === "stdout"
      ? ["ignore", "inherit", "ignore"]
      : ["ignore", "ignore", "inherit"];
  return `
    const { spawn } = require("node:child_process");
    const descendant = spawn("/bin/sh", ["-c", "sleep 5"], { stdio: ${JSON.stringify(stdio)} });
    process.${stream}.write("early");
  `;
}

describe("the child environment", () => {
  it("inherits this process's environment when no extra variables are given", async () => {
    const result = await exec(...printEnv("PATH"));

    expect(result.stdout).toBe(process.env.PATH);
  });

  it("adds the extra variables the caller asked for", async () => {
    const [command, args] = printEnv("TICKET_RUNNER_STAGE");

    const result = await exec(command, args, {
      extraEnv: { TICKET_RUNNER_STAGE: "implement" },
    });

    expect(result.stdout).toBe("implement");
  });

  it("keeps the inherited environment underneath them", async () => {
    const [command, args] = printEnv("PATH");

    const result = await exec(command, args, {
      extraEnv: { TICKET_RUNNER_STAGE: "implement" },
    });

    expect(result.stdout).toBe(process.env.PATH);
  });

  it("leaves this process's own environment alone", async () => {
    const before = { ...process.env };
    const [command, args] = printEnv("TICKET_RUNNER_STAGE");

    await exec(command, args, { extraEnv: { TICKET_RUNNER_STAGE: "implement" } });

    expect({ ...process.env }).toEqual(before);
  });
});

describe("streaming the child's output", () => {
  /** Prints on one stream, then stays alive long enough to prove the point. */
  function printThenLinger(stream: "stdout" | "stderr"): [string, string[]] {
    return [
      "node",
      ["-e", `process.${stream}.write("early"); setTimeout(() => {}, 300);`],
    ];
  }

  it("hands a stdout chunk to the caller while the child is still running", async () => {
    let arrived!: (chunk: string) => void;
    const chunk = new Promise<string>((resolve) => {
      arrived = resolve;
    });

    const running = exec(...printThenLinger("stdout"), { onStdout: arrived });

    await expect(Promise.race([chunk, running.then(() => "exited")])).resolves.toBe("early");
    await running;
  });

  it("hands a stderr chunk over the same way", async () => {
    let arrived!: (chunk: string) => void;
    const chunk = new Promise<string>((resolve) => {
      arrived = resolve;
    });

    const running = exec(...printThenLinger("stderr"), { onStderr: arrived });

    await expect(Promise.race([chunk, running.then(() => "exited")])).resolves.toBe("early");
    await running;
  });

  it("still returns the whole output the chunks add up to", async () => {
    const seen: string[] = [];
    const script = `process.stdout.write("one"); process.stdout.write("two");`;

    const result = await exec("node", ["-e", script], {
      onStdout: (chunk) => seen.push(chunk),
    });

    expect(seen.join("")).toBe("onetwo");
    expect(result.stdout).toBe("onetwo");
  });
});

describe("the wall-clock limit", () => {
  it("settles once the child is dead, with what it printed before the kill", async () => {
    const script = `${leaveDescendantHolding("stdout")} setTimeout(() => {}, 5_000);`;
    const startedAt = Date.now();

    const result = await exec("node", ["-e", script], { timeoutMs: 200 });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("early");
    expect(result.output).toBe("early");
  });

  it("reports the child's own exit code when it beat the limit on its own", async () => {
    const script = `${leaveDescendantHolding("stdout")} descendant.unref(); process.exitCode = 3;`;
    const startedAt = Date.now();

    const result = await exec("node", ["-e", script], { timeoutMs: 1_000 });

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("early");
  });
});

describe("the kill at the wall-clock limit", () => {
  /** Whether a process of that id is still there to be signalled. */
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** The pid a child printed, the way each script below names its background process. */
  function backgroundPid(stdout: string): number {
    return Number(stdout.trim().split("\n")[0]);
  }

  /** A killed process lingers as a zombie until its new parent reaps it. */
  async function goneSoon(pid: number): Promise<boolean> {
    for (let tries = 0; tries < 20; tries += 1) {
      if (!alive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  it("takes a process the command started in the background with it", async () => {
    const result = await exec("sleep 30 & echo $!; wait", [], { shell: true, timeoutMs: 300 });
    const pid = backgroundPid(result.stdout);

    expect(result.timedOut).toBe(true);
    expect(await goneSoon(pid)).toBe(true);
  });

  // Claude Code starts each Bash tool command in a session of its own, so a
  // Stage's test suite is in no process group the Stage itself is in.
  it("takes a background process that left for a process group of its own", async () => {
    const script = `
      const { spawn } = require("node:child_process");
      const shell = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
      process.stdout.write(shell.pid + "\\n");
      setTimeout(() => {}, 30_000);
    `;

    const result = await exec("node", ["-e", script], { timeoutMs: 500 });
    const pid = backgroundPid(result.stdout);

    expect(result.timedOut).toBe(true);
    expect(await goneSoon(pid)).toBe(true);
  });

  it("kills what ignores SIGTERM once the grace is over", async () => {
    const result = await exec("trap '' TERM; sleep 30 & echo $!; wait", [], {
      shell: true,
      timeoutMs: 300,
      killGraceMs: 300,
    });
    const pid = backgroundPid(result.stdout);

    expect(result.timedOut).toBe(true);
    expect(await goneSoon(pid)).toBe(true);
  });

  it("asks with SIGTERM first, so a command can tidy up before it goes", async () => {
    const script = `
      process.on("SIGTERM", () => { process.stdout.write("tidied"); process.exit(0); });
      setTimeout(() => {}, 30_000);
    `;

    const result = await exec("node", ["-e", script], { timeoutMs: 500 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("tidied");
  });
});

describe("a child that exits on its own", () => {
  it("settles without waiting for a descendant holding stdout", async () => {
    const script = `${leaveDescendantHolding("stdout")} descendant.unref(); process.exitCode = 3;`;
    const startedAt = Date.now();

    const result = await exec("node", ["-e", script]);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("early");
    expect(result.output).toBe("early");
  });

  it("settles without waiting for a descendant holding stderr", async () => {
    const script = `${leaveDescendantHolding("stderr")} descendant.unref(); process.exitCode = 3;`;
    const startedAt = Date.now();

    const result = await exec("node", ["-e", script]);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("early");
    expect(result.output).toBe("early");
  });

  it("returns the whole output of a child that leaves no descendants", async () => {
    const script = `process.stdout.write("one"); process.stdout.write("last"); process.exitCode = 3;`;

    const result = await exec("node", ["-e", script]);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("onelast");
    expect(result.output).toBe("onelast");
  });
});
