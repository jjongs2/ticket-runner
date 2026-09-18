import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILENAME, ConfigError, loadConfig } from "./config.js";

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "agent-pipeline-config-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
  }
  return root;
}

describe("loadConfig", () => {
  it("applies the documented defaults when no config file exists", () => {
    const config = loadConfig(repoWith({}));

    expect(config.gates).toEqual({ checks: true, ci: true });
    expect(config.permissionMode).toBe("auto");
    expect(config.ciTimeoutMinutes).toBe(30);
    expect(config.checkTimeoutMinutes).toBe(15);
    expect(config.stages.implement).toEqual({
      model: "claude-opus-5",
      maxTurns: 300,
      maxMinutes: 60,
      extraPrompt: "",
    });
    expect(config.stages.verify).toMatchObject({ maxTurns: 80, maxMinutes: 20 });
    expect(config.stages.fix).toMatchObject({ maxTurns: 150, maxMinutes: 40 });
    expect(config.stages.conflict).toMatchObject({ maxTurns: 120, maxMinutes: 30 });
    expect(config.labels).toEqual({
      needsTriage: "needs-triage",
      needsInfo: "needs-info",
      readyForAgent: "ready-for-agent",
      readyForHuman: "ready-for-human",
      wontfix: "wontfix",
      inProgress: "in-progress",
    });
  });

  it("names no base branch of its own, leaving the Target's default to answer", () => {
    expect(loadConfig(repoWith({})).baseBranch).toBeUndefined();
  });

  it("takes the base branch the config file names", () => {
    const root = repoWith({ [CONFIG_FILENAME]: JSON.stringify({ baseBranch: "trunk" }) });

    expect(loadConfig(root).baseBranch).toBe("trunk");
  });

  it.each(["", 7, null])(
    "rejects %o as a base branch with a message naming the field",
    (value) => {
      const root = repoWith({ [CONFIG_FILENAME]: JSON.stringify({ baseBranch: value }) });

      expect(() => loadConfig(root)).toThrowError(ConfigError);
      expect(() => loadConfig(root)).toThrowError(/baseBranch/);
    },
  );

  it("infers Checks from the package.json scripts", () => {
    const root = repoWith({
      "package.json": JSON.stringify({
        scripts: { test: "vitest run", typecheck: "tsc --noEmit", build: "tsc" },
      }),
    });

    expect(loadConfig(root).checks).toEqual(["npm test", "npm run typecheck"]);
  });

  it("infers no Checks when package.json has neither script", () => {
    const root = repoWith({
      "package.json": JSON.stringify({ scripts: { build: "tsc" } }),
    });

    expect(loadConfig(root).checks).toEqual([]);
  });

  it("prefers configured Checks over the inferred ones", () => {
    const root = repoWith({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      [CONFIG_FILENAME]: JSON.stringify({ checks: ["make check"] }),
    });

    expect(loadConfig(root).checks).toEqual(["make check"]);
  });

  it("lets a configured empty Check list opt out of inference", () => {
    const root = repoWith({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      [CONFIG_FILENAME]: JSON.stringify({ checks: [], gates: { checks: false } }),
    });

    expect(loadConfig(root).checks).toEqual([]);
  });

  it("merges a partial config over the defaults field by field", () => {
    const root = repoWith({
      [CONFIG_FILENAME]: JSON.stringify({
        stages: { verify: { maxMinutes: 5 } },
        gates: { ci: false },
      }),
    });
    const config = loadConfig(root);

    expect(config.stages.verify).toEqual({
      model: "claude-opus-5",
      maxTurns: 80,
      maxMinutes: 5,
      extraPrompt: "",
    });
    expect(config.gates).toEqual({ checks: true, ci: false });
  });

  it("takes limits for the conflict Stage like any other", () => {
    const root = repoWith({
      [CONFIG_FILENAME]: JSON.stringify({ stages: { conflict: { maxTurns: 40 } } }),
    });

    expect(loadConfig(root).stages.conflict).toEqual({
      model: "claude-opus-5",
      maxTurns: 40,
      maxMinutes: 30,
      extraPrompt: "",
    });
  });

  it("takes a configured Check limit as given", () => {
    const root = repoWith({
      [CONFIG_FILENAME]: JSON.stringify({ checkTimeoutMinutes: 3 }),
    });

    expect(loadConfig(root).checkTimeoutMinutes).toBe(3);
  });

  it.each([0, -5, "fifteen"])(
    "rejects %o as a Check limit with a message naming the field",
    (value) => {
      const root = repoWith({
        [CONFIG_FILENAME]: JSON.stringify({ checkTimeoutMinutes: value }),
      });

      expect(() => loadConfig(root)).toThrowError(ConfigError);
      expect(() => loadConfig(root)).toThrowError(/checkTimeoutMinutes/);
    },
  );

  it("rejects an invalid field with a message naming it", () => {
    const root = repoWith({
      [CONFIG_FILENAME]: JSON.stringify({ ciTimeoutMinutes: "thirty" }),
    });

    expect(() => loadConfig(root)).toThrowError(ConfigError);
    expect(() => loadConfig(root)).toThrowError(/ciTimeoutMinutes/);
  });

  it("names the offending nested field", () => {
    const root = repoWith({
      [CONFIG_FILENAME]: JSON.stringify({ stages: { implement: { maxTurns: -1 } } }),
    });

    expect(() => loadConfig(root)).toThrowError(/stages\.implement\.maxTurns/);
  });

  it("names an unknown field rather than ignoring it", () => {
    const root = repoWith({
      [CONFIG_FILENAME]: JSON.stringify({ permissionMod: "auto" }),
    });

    expect(() => loadConfig(root)).toThrowError(/permissionMod/);
  });

  it("rejects an unknown permission mode by name", () => {
    const root = repoWith({
      [CONFIG_FILENAME]: JSON.stringify({ permissionMode: "yolo" }),
    });

    expect(() => loadConfig(root)).toThrowError(/permissionMode/);
  });

  it("reports malformed JSON as a config error", () => {
    const root = repoWith({ [CONFIG_FILENAME]: "{ not json" });

    expect(() => loadConfig(root)).toThrowError(ConfigError);
  });
});
