import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILENAME, ConfigError, loadConfig } from "./config.js";

/** The Version doing the refusing, which an unknown key is reported with. */
const VERSION = "0.4.0+331d79c";

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "agent-pipeline-config-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
  }
  return root;
}

describe("loadConfig", () => {
  it("applies the documented defaults when no config file exists", () => {
    const config = loadConfig(repoWith({}), VERSION);

    expect(config.gates).toEqual({ checks: true, ci: true });
    expect(config.permissionMode).toBe("auto");
    expect(config.ciTimeoutMinutes).toBe(30);
    expect(config.ciGraceMinutes).toBe(5);
    expect(config.checkTimeoutMinutes).toBe(15);
    expect(config.lanes).toBe(1);
    expect(config.stages.implement).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
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
    expect(loadConfig(repoWith({}), VERSION).baseBranch).toBeUndefined();
  });

  it("takes the base branch the config file names", () => {
    const root = repoWith({ [CONFIG_FILENAME]: JSON.stringify({ baseBranch: "trunk" }) });

    expect(loadConfig(root, VERSION).baseBranch).toBe("trunk");
  });

  it.each(["", 7, null])(
    "rejects %o as a base branch with a message naming the field",
    (value) => {
      const root = repoWith({ [CONFIG_FILENAME]: JSON.stringify({ baseBranch: value }) });

      expect(() => loadConfig(root, VERSION)).toThrowError(ConfigError);
      expect(() => loadConfig(root, VERSION)).toThrowError(/baseBranch/);
    },
  );

  it("infers Checks from the package.json scripts", () => {
    const root = repoWith({
      "package.json": JSON.stringify({
        scripts: { test: "vitest run", typecheck: "tsc --noEmit", build: "tsc" },
      }),
    });

    expect(loadConfig(root, VERSION).checks).toEqual(["npm test", "npm run typecheck"]);
  });

  it("infers no Checks when package.json has neither script", () => {
    const root = repoWith({
      "package.json": JSON.stringify({ scripts: { build: "tsc" } }),
    });

    expect(loadConfig(root, VERSION).checks).toEqual([]);
  });

  it("prefers configured Checks over the inferred ones", () => {
    const root = repoWith({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      [CONFIG_FILENAME]: JSON.stringify({ checks: ["make check"] }),
    });

    expect(loadConfig(root, VERSION).checks).toEqual(["make check"]);
  });

  it("lets a configured empty Check list opt out of inference", () => {
    const root = repoWith({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      [CONFIG_FILENAME]: JSON.stringify({ checks: [], gates: { checks: false } }),
    });

    expect(loadConfig(root, VERSION).checks).toEqual([]);
  });

  it("merges a partial config over the defaults field by field", () => {
    const root = repoWith({
      [CONFIG_FILENAME]: JSON.stringify({
        stages: { verify: { maxMinutes: 5 } },
        gates: { ci: false },
      }),
    });
    const config = loadConfig(root, VERSION);

    expect(config.stages.verify).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
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

    expect(loadConfig(root, VERSION).stages.conflict).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
      maxTurns: 40,
      maxMinutes: 30,
      extraPrompt: "",
    });
  });

  it("takes the effort the config names for one Stage and leaves the rest alone", () => {
    const root = repoWith({
      [CONFIG_FILENAME]: JSON.stringify({ stages: { verify: { effort: "max" } } }),
    });
    const config = loadConfig(root, VERSION);

    expect(config.stages.verify.effort).toBe("max");
    expect(config.stages.implement.effort).toBe("high");
    expect(config.stages.fix.effort).toBe("high");
    expect(config.stages.conflict.effort).toBe("high");
  });

  it.each(["low", "medium", "high", "xhigh", "max"])("takes %o as an effort", (level) => {
    const root = repoWith({
      [CONFIG_FILENAME]: JSON.stringify({ stages: { implement: { effort: level } } }),
    });

    expect(loadConfig(root, VERSION).stages.implement.effort).toBe(level);
  });

  it.each(["", "highest", "HIGH", 3, null])(
    "rejects %o as an effort with a message naming the field",
    (value) => {
      const root = repoWith({
        [CONFIG_FILENAME]: JSON.stringify({ stages: { fix: { effort: value } } }),
      });

      expect(() => loadConfig(root, VERSION)).toThrowError(ConfigError);
      expect(() => loadConfig(root, VERSION)).toThrowError(/stages\.fix\.effort/);
    },
  );

  it("takes a configured Check limit as given", () => {
    const root = repoWith({
      [CONFIG_FILENAME]: JSON.stringify({ checkTimeoutMinutes: 3 }),
    });

    expect(loadConfig(root, VERSION).checkTimeoutMinutes).toBe(3);
  });

  it.each([0, -5, "fifteen"])(
    "rejects %o as a Check limit with a message naming the field",
    (value) => {
      const root = repoWith({
        [CONFIG_FILENAME]: JSON.stringify({ checkTimeoutMinutes: value }),
      });

      expect(() => loadConfig(root, VERSION)).toThrowError(ConfigError);
      expect(() => loadConfig(root, VERSION)).toThrowError(/checkTimeoutMinutes/);
    },
  );

  it("takes a configured CI grace as given", () => {
    const root = repoWith({ [CONFIG_FILENAME]: JSON.stringify({ ciGraceMinutes: 8 }) });

    expect(loadConfig(root, VERSION).ciGraceMinutes).toBe(8);
  });

  it.each([0, -5, "five"])(
    "rejects %o as a CI grace with a message naming the field",
    (value) => {
      const root = repoWith({
        [CONFIG_FILENAME]: JSON.stringify({ ciGraceMinutes: value }),
      });

      expect(() => loadConfig(root, VERSION)).toThrowError(ConfigError);
      expect(() => loadConfig(root, VERSION)).toThrowError(/ciGraceMinutes/);
    },
  );

  it("takes a configured Lane count as given", () => {
    const root = repoWith({ [CONFIG_FILENAME]: JSON.stringify({ lanes: 4 }) });

    expect(loadConfig(root, VERSION).lanes).toBe(4);
  });

  it.each([0, -1, 1.5, "two"])(
    "rejects %o as a Lane count with a message naming the field",
    (value) => {
      const root = repoWith({ [CONFIG_FILENAME]: JSON.stringify({ lanes: value }) });

      expect(() => loadConfig(root, VERSION)).toThrowError(ConfigError);
      expect(() => loadConfig(root, VERSION)).toThrowError(/lanes/);
    },
  );

  it("rejects an invalid field with a message naming it", () => {
    const root = repoWith({
      [CONFIG_FILENAME]: JSON.stringify({ ciTimeoutMinutes: "thirty" }),
    });

    expect(() => loadConfig(root, VERSION)).toThrowError(ConfigError);
    expect(() => loadConfig(root, VERSION)).toThrowError(/ciTimeoutMinutes/);
  });

  it("names the offending nested field", () => {
    const root = repoWith({
      [CONFIG_FILENAME]: JSON.stringify({ stages: { implement: { maxTurns: -1 } } }),
    });

    expect(() => loadConfig(root, VERSION)).toThrowError(/stages\.implement\.maxTurns/);
  });

  it("names an unknown field rather than ignoring it", () => {
    const root = repoWith({
      [CONFIG_FILENAME]: JSON.stringify({ permissionMod: "auto" }),
    });

    expect(() => loadConfig(root, VERSION)).toThrowError(/permissionMod/);
  });

  it("rejects an unknown permission mode by name", () => {
    const root = repoWith({
      [CONFIG_FILENAME]: JSON.stringify({ permissionMode: "yolo" }),
    });

    expect(() => loadConfig(root, VERSION)).toThrowError(/permissionMode/);
  });

  it("reports malformed JSON as a config error", () => {
    const root = repoWith({ [CONFIG_FILENAME]: "{ not json" });

    expect(() => loadConfig(root, VERSION)).toThrowError(ConfigError);
  });
});

describe("a key this install does not know", () => {
  /** The message a refusal came with, which is all a human ever sees of it. */
  function refusal(config: Record<string, unknown>): string {
    try {
      loadConfig(repoWith({ [CONFIG_FILENAME]: JSON.stringify(config) }), VERSION);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("the config was not refused");
  }

  it("is refused by name, and with the Version that refused it", () => {
    const message = refusal({ retries: 3 });

    expect(message).toContain("retries");
    expect(
      message.endsWith(
        `Refused by agent-pipeline ${VERSION}, so the key may be newer than this install.`,
      ),
    ).toBe(true);
  });

  it("says the same of a key nested inside one the schema knows", () => {
    expect(refusal({ gates: { flakes: true } })).toContain(
      `Refused by agent-pipeline ${VERSION}`,
    );
  });

  it("leaves a bad value alone: nothing about that is a stale install", () => {
    expect(refusal({ lanes: 0 })).not.toContain("newer than this install");
  });
});
