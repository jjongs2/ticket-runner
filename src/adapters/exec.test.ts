import { describe, expect, it } from "vitest";
import { exec } from "./exec.js";

/** Printing one variable is enough to see what the child actually inherited. */
function printEnv(name: string): [string, string[]] {
  return ["node", ["-e", `process.stdout.write(String(process.env.${name}))`]];
}

describe("the child environment", () => {
  it("inherits this process's environment when no extra variables are given", async () => {
    const result = await exec(...printEnv("PATH"));

    expect(result.stdout).toBe(process.env.PATH);
  });

  it("adds the extra variables the caller asked for", async () => {
    const [command, args] = printEnv("AGENT_PIPELINE_STAGE");

    const result = await exec(command, args, {
      extraEnv: { AGENT_PIPELINE_STAGE: "implement" },
    });

    expect(result.stdout).toBe("implement");
  });

  it("keeps the inherited environment underneath them", async () => {
    const [command, args] = printEnv("PATH");

    const result = await exec(command, args, {
      extraEnv: { AGENT_PIPELINE_STAGE: "implement" },
    });

    expect(result.stdout).toBe(process.env.PATH);
  });

  it("leaves this process's own environment alone", async () => {
    const before = { ...process.env };
    const [command, args] = printEnv("AGENT_PIPELINE_STAGE");

    await exec(command, args, { extraEnv: { AGENT_PIPELINE_STAGE: "implement" } });

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
