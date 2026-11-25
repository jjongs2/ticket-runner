import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { startupMessages } from "./startup.js";

function config(overrides: Partial<Config>): Config {
  return {
    lanes: 1,
    checks: ["npm test"],
    merge: true,
    checksNamed: true,
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
      pr: {
        model: "claude-opus-5-5",
        effort: "high",
        maxTurns: 60,
        maxMinutes: 20,
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
  it("says nothing when Checks exist", () => {
    expect(startupMessages(config({}))).toEqual({ warnings: [] });
    expect(startupMessages(config({ checksNamed: false }))).toEqual({ warnings: [] });
  });

  it("refuses to start when the config names no Check and none could be inferred, naming `\"checks\": []`", () => {
    const { refusal, warnings } = startupMessages(config({ checks: [], checksNamed: false }));

    expect(refusal).toMatch(/no check commands/i);
    expect(refusal).toContain("ticket-runner.json");
    expect(refusal).toContain('`"checks": []`');
    expect(refusal).toContain("The Stage prompts name them, and a red CI is graded with them at the branch's merge-base");
    expect(refusal).not.toMatch(/gates/);
    expect(warnings).toEqual([]);
  });

  it("starts with a warning when the config names `\"checks\": []`", () => {
    const { refusal, warnings } = startupMessages(config({ checks: [], checksNamed: true }));

    expect(refusal).toBeUndefined();
    expect(warnings).toEqual([
      "No Check command: `checks` is `[]` in ticket-runner.json, so the Stage prompts name none and a red CI is not graded at the branch's merge-base.",
    ]);
  });
});
