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

  /**
   * The Checks section is the one thing in the document a Target acts on before
   * it ever runs a Stage: a Target whose Checks cannot share a machine has to
   * read this to know to stay at one Lane. Pinned by section so that rewording
   * the document is free but dropping the warning is not.
   */
  it("warns under Checks that the Lanes of a Run share the Target", () => {
    const checks = section(CONVENTIONS_DOC, "Checks");

    expect(checks).toContain("worktree");
    expect(checks).toContain("`lanes`");
  });
});

/** One `## ` section's body, and a legible failure when the heading is gone. */
function section(doc: string, heading: string): string {
  const found = doc.split(`\n## `).find((part) => part.startsWith(`${heading}\n`));
  if (found === undefined) throw new Error(`no "## ${heading}" section in the document`);
  return found;
}
