import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONVENTIONS_DOC, CONVENTIONS_PATH } from "./conventions.js";

describe("the conventions document", () => {
  /**
   * This repository is a Target of its own pipeline, and a Run refuses a Target
   * whose copy is missing but never reads what it says. Without this the copy
   * drifts silently from the text `init` writes, and the one repository where
   * the difference would be noticed is the one nobody checks.
   */
  it("is checked in here exactly as `init` writes it", () => {
    expect(readFileSync(CONVENTIONS_PATH, "utf8")).toBe(CONVENTIONS_DOC);
  });

  it("warns under Checks that Lanes share the Target", () => {
    const checks = CONVENTIONS_DOC.split("\n## ").find((section) =>
      section.startsWith("Checks\n"),
    );

    expect(checks).toContain("worktree");
    expect(checks).toContain("`lanes`");
  });
});
