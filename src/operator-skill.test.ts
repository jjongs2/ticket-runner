import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPERATOR_SKILL_PATH, operatorSkill } from "./operator-skill.js";

describe("the Operator's skill", () => {
  /**
   * This repository is a Target of its own pipeline, and a Run refuses a Target
   * without the skill but never reads what it says. Without this our copy
   * drifts silently from the text `init` writes.
   */
  it("is checked in here exactly as `init` writes it", () => {
    expect(readFileSync(OPERATOR_SKILL_PATH, "utf8")).toBe(operatorSkill());
  });

  /** A project skill with no name or description is one no session loads. */
  it("opens with the frontmatter a project skill is loaded by", () => {
    expect(operatorSkill()).toMatch(/^---\nname: ticket-runner\ndescription: .+\n---\n/);
  });
});
