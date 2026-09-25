import { describe, expect, it } from "vitest";
import { hostKind } from "./host.js";

describe("hostKind", () => {
  it("calls a Claude Code cloud session a cloud Host", () => {
    expect(hostKind({ CLAUDE_CODE_REMOTE: "true" })).toBe("cloud");
  });

  it("calls anything else a workstation", () => {
    expect(hostKind({})).toBe("workstation");
    expect(hostKind({ CLAUDE_CODE_REMOTE: "false" })).toBe("workstation");
    expect(hostKind({ CLAUDE_CODE_REMOTE: "" })).toBe("workstation");
  });
});
