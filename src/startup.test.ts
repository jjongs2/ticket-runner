import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { startupMessages } from "./startup.js";

function config(overrides: Partial<Config>): Config {
  return {
    lanes: 1,
    checks: ["npm test"],
    gates: { checks: true, ci: true },
    stages: {
      implement: {
        model: "claude-opus-5-5",
        effort: "high",
        maxTurns: 300,
        maxMinutes: 60,
        extraPrompt: "",
      },
      verify: {
        model: "claude-opus-5-5",
        effort: "high",
        maxTurns: 80,
        maxMinutes: 20,
        extraPrompt: "",
      },
      fix: {
        model: "claude-opus-5-5",
        effort: "high",
        maxTurns: 150,
        maxMinutes: 40,
        extraPrompt: "",
      },
      conflict: {
        model: "claude-opus-5-5",
        effort: "high",
        maxTurns: 120,
        maxMinutes: 30,
        extraPrompt: "",
      },
    },
    permissionMode: "auto",
    ciTimeoutMinutes: 30,
    ciGraceMinutes: 5,
    checkTimeoutMinutes: 15,
    labels: {
      needsTriage: "needs-triage",
      needsInfo: "needs-info",
      readyForAgent: "ready-for-agent",
      readyForHuman: "ready-for-human",
      wontfix: "wontfix",
      inProgress: "in-progress",
    },
    ...overrides,
  };
}

describe("startupMessages", () => {
  it("says nothing when both gates are on and Checks exist", () => {
    expect(startupMessages(config({}))).toEqual({ warnings: [] });
  });

  it("refuses to start when the Checks gate is on but no Check is configured", () => {
    const { refusal } = startupMessages(config({ checks: [] }));

    expect(refusal).toMatch(/no check commands/i);
    expect(refusal).toContain("ticket-runner.json");
    expect(refusal).toMatch(/gates.*checks.*false/is);
  });

  it("lets a repo with no Checks run once the gate is turned off", () => {
    const { refusal, warnings } = startupMessages(
      config({ checks: [], gates: { checks: false, ci: true } }),
    );

    expect(refusal).toBeUndefined();
    expect(warnings).toEqual([
      "Checks gate off: nothing deterministic will gate a merge.",
    ]);
  });

  it("warns when the CI gate is off", () => {
    const { warnings } = startupMessages(config({ gates: { checks: true, ci: false } }));

    expect(warnings).toEqual([
      "CI gate off: a pull request with no checks will still be merged.",
    ]);
  });

  it("warns once per disabled gate", () => {
    const { warnings } = startupMessages(
      config({ checks: [], gates: { checks: false, ci: false } }),
    );

    expect(warnings).toHaveLength(2);
  });
});
