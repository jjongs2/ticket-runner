import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pipelineVersion } from "./adapters/version.js";
import { CONVENTIONS_PATH, conventionsDoc, conventionsMark } from "./conventions.js";

describe("the conventions document", () => {
  /**
   * This repository is a Target of its own pipeline, and a Run refuses a Target
   * whose copy is missing but never reads what it says. Without this the copy
   * drifts silently from the text `init` writes, and the one repository where
   * the difference would be noticed is the one nobody checks.
   *
   * Written by this checkout's own Version, because the document carries the
   * number that wrote it: a Version PR that raises the number and leaves the
   * copy here alone is a Target `init` would rewrite, and this is what says so.
   */
  it("is checked in here exactly as `init` writes it", async () => {
    expect(readFileSync(CONVENTIONS_PATH, "utf8")).toBe(conventionsDoc(await pipelineVersion()));
  });

  /**
   * The Checks section is the one thing in the document a Target acts on before
   * it ever runs a Stage: a Target whose Checks cannot share a machine has to
   * read this to know to stay at one Lane. Pinned by section so that rewording
   * the document is free but dropping the warning is not.
   */
  it("warns under Checks that the Lanes of a Run share the Target", () => {
    const checks = section(conventionsDoc("0.4.0"), "Checks");

    expect(checks).toContain("worktree");
    expect(checks).toContain("`lanes`");
  });

  /**
   * The mark is the one thing `init` and a Run read the document for, and the
   * one thing its readers must never meet: it sits on the first line, inside an
   * HTML comment, so the heading renders as it always did.
   */
  it("carries the Version in a hidden marker on its first line", () => {
    const [first = "", ...rest] = conventionsDoc("0.4.0").split("\n");

    expect(first).toBe("# agent-pipeline conventions <!-- agent-pipeline:version 0.4.0 -->");
    expect(rest.join("\n")).not.toContain("agent-pipeline:version");
  });

  it("marks a development checkout with its number and not its commit", () => {
    expect(conventionsMark(conventionsDoc("0.4.0+331d79c.dirty"))).toBe("0.4.0");
  });

  it("says nothing about Versions beyond the mark it bears", () => {
    const body = conventionsDoc("0.4.0").split("\n").slice(1).join("\n");

    expect(body.toLowerCase()).not.toContain("version");
  });
});

describe("a copy with no Version to stamp", () => {
  /**
   * A marker nothing can read is a marker that is not there, so none is
   * written: `init` would otherwise rewrite the same document every time it
   * ran, reporting each time that the copy carried no Version.
   */
  it("carries no marker rather than one saying so", () => {
    const doc = conventionsDoc("unknown");

    expect(doc.split("\n")[0]).toBe("# agent-pipeline conventions");
    expect(conventionsMark(doc)).toBeUndefined();
  });
});

describe("the mark a Target's copy bears", () => {
  it("reads the number the document was written by", () => {
    expect(conventionsMark(conventionsDoc("0.4.0"))).toBe("0.4.0");
  });

  it("reads nothing from a copy an older pipeline wrote", () => {
    expect(conventionsMark("# agent-pipeline conventions\n\nWhat it requires.\n")).toBeUndefined();
  });

  it("reads nothing from a Target that has no copy at all", () => {
    expect(conventionsMark(undefined)).toBeUndefined();
  });

  it("reads only the first line, so a document quoting the marker is unmarked", () => {
    const quoted = "# agent-pipeline conventions\n\n<!-- agent-pipeline:version 9.0.0 -->\n";

    expect(conventionsMark(quoted)).toBeUndefined();
  });

  it("reads nothing from a mark carrying something that is not a number", () => {
    expect(conventionsMark("# c <!-- agent-pipeline:version unknown -->\n")).toBeUndefined();
  });
});

/** One `## ` section's body, and a legible failure when the heading is gone. */
function section(doc: string, heading: string): string {
  const found = doc.split(`\n## `).find((part) => part.startsWith(`${heading}\n`));
  if (found === undefined) throw new Error(`no "## ${heading}" section in the document`);
  return found;
}
