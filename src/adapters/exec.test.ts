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

    const result = await exec(command, args, { env: { AGENT_PIPELINE_STAGE: "implement" } });

    expect(result.stdout).toBe("implement");
  });

  it("keeps the inherited environment underneath them", async () => {
    const [command, args] = printEnv("PATH");

    const result = await exec(command, args, { env: { AGENT_PIPELINE_STAGE: "implement" } });

    expect(result.stdout).toBe(process.env.PATH);
  });

  it("leaves this process's own environment alone", async () => {
    const [command, args] = printEnv("AGENT_PIPELINE_STAGE");
    await exec(command, args, { env: { AGENT_PIPELINE_STAGE: "implement" } });

    expect(process.env.AGENT_PIPELINE_STAGE).toBeUndefined();
  });
});
