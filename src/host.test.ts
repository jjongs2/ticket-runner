import { describe, expect, it } from "vitest";
import { CLOUD_ENV_VAR, hostKind } from "./host.js";

describe("hostKind", () => {
  it("calls a Claude Code cloud session a cloud Host", () => {
    expect(hostKind({ [CLOUD_ENV_VAR]: "true" })).toBe("cloud");
  });

  it("calls anything else a workstation", () => {
    expect(hostKind({})).toBe("workstation");
    expect(hostKind({ [CLOUD_ENV_VAR]: "false" })).toBe("workstation");
    expect(hostKind({ [CLOUD_ENV_VAR]: "" })).toBe("workstation");
  });
});
