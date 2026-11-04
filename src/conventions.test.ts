import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pipelineVersion } from "./adapters/version.js";
import { CONVENTIONS_PATH, conventionsDoc, conventionsMark } from "./conventions.js";
import { bareAcronymPRs, capitalisedDroppedWords } from "./testing/dropped-words.js";

describe("the conventions document", () => {
  /**
   * This repository is a Target of its own pipeline, and a Run refuses a Target
   * whose copy is missing but never reads what it says. Without this the copy
   * drifts silently from the text `init` writes, and the one repository where
   * the difference would be noticed is the one nobody checks.
   *
   * Written by this checkout's own version, because the document carries the
   * number that wrote it: a release PR that raises the number and leaves the
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

  it("says under Commits that a Stage's title answer, not the first commit, titles the pull request", () => {
    const commits = section(conventionsDoc("0.4.0"), "Commits");

    expect(commits).toContain("`title` the implement and fix Stages each answer");
    expect(commits).toContain("becomes the pull request title");
    expect(commits).not.toMatch(/first commit/i);
  });

  /**
   * The pipeline reads a subject's shape and no number: a Ticket is one branch
   * and one pull request, and the squash commit's `Closes #<n>` names it.
   */
  it("asks a commit subject for its shape and not the Ticket number", () => {
    const doc = conventionsDoc("0.4.0");
    const commits = section(doc, "Commits");

    expect(commits).toContain("Subject: `<type>(<scope>): <summary>`");
    expect(commits).toMatch(/reads the shape, never the words/);
    expect(doc).not.toContain("(#<n>)");
    expect(doc).not.toMatch(/Ticket number/);
  });

  /**
   * The mark is the one thing `init` and a Run read the document for, and the
   * one thing its readers must never meet: it sits on the first line, inside an
   * HTML comment, so the heading renders as it always did.
   */
  it("carries the version in a hidden marker on its first line", () => {
    const [first = "", ...rest] = conventionsDoc("0.4.0").split("\n");

    expect(first).toBe("# ticket-runner conventions <!-- ticket-runner:version 0.4.0 -->");
    expect(rest.join("\n")).not.toContain("ticket-runner:version");
  });

  /**
   * A Target carries no glossary, so a word the glossary dropped reads to an
   * agent there as a term it has no definition for. Written as the ordinary
   * word it is, it needs none.
   */
  it("writes the words the glossary dropped as ordinary words", () => {
    const doc = conventionsDoc("0.4.0");

    expect(capitalisedDroppedWords(doc)).toEqual([]);
    expect(bareAcronymPRs(doc)).toEqual([]);
  });

  /**
   * The terms the glossary does list are capitalised, and an agent in a Target
   * has never seen their definitions, so the document says each in a few words
   * where it first uses it.
   */
  it.each([
    ["Target", "the repository a Run takes its work from"],
    ["Run", "one invocation of the pipeline"],
    ["Host", "the machine it executes on"],
    ["Ticket", "GitHub issues each sized for one session of work"],
    ["Stage", "one Claude Code session with a single purpose"],
    ["Note", "defects it met that belong to another Ticket or to none yet"],
    ["Hand-off", "A Hand-off gives a Ticket to a human rather than merging it"],
    ["Operator", "the Claude session a human opens on a cloud Host"],
    ["Acceptance Criteria", "the only thing the verify Stage grades"],
    ["Check", "a command the pipeline runs itself on a Ticket's code"],
    ["Lane", "each Lane holds one Ticket in progress"],
    ["Release", "given back to the pipeline for a later Run to take up again"],
    ["Stop", "finish the Tickets its Lanes hold and take no more"],
  ])("glosses %s", (_term, gloss) => {
    expect(conventionsDoc("0.4.0")).toContain(gloss);
  });

  it("marks a development checkout with its number and not its commit", () => {
    expect(conventionsMark(conventionsDoc("0.4.0+331d79c.dirty"))).toBe("0.4.0");
  });

  it("says nothing about versions beyond the mark it bears", () => {
    const body = conventionsDoc("0.4.0").split("\n").slice(1).join("\n");

    expect(body.toLowerCase()).not.toContain("version");
  });
});

describe("a copy with no version to stamp", () => {
  /**
   * A marker nothing can read is a marker that is not there, so none is
   * written: `init` would otherwise rewrite the same document every time it
   * ran, reporting each time that the copy carried no version.
   */
  it("carries no marker rather than one saying so", () => {
    const doc = conventionsDoc("unknown");

    expect(doc.split("\n")[0]).toBe("# ticket-runner conventions");
    expect(conventionsMark(doc)).toBeUndefined();
  });
});

describe("the mark a Target's copy bears", () => {
  it("reads the number the document was written by", () => {
    expect(conventionsMark(conventionsDoc("0.4.0"))).toBe("0.4.0");
  });

  it("reads nothing from a copy an older pipeline wrote", () => {
    expect(conventionsMark("# ticket-runner conventions\n\nWhat it requires.\n")).toBeUndefined();
  });

  it("reads nothing from a Target that has no copy at all", () => {
    expect(conventionsMark(undefined)).toBeUndefined();
  });

  it("reads only the first line, so a document quoting the marker is unmarked", () => {
    const quoted = "# ticket-runner conventions\n\n<!-- ticket-runner:version 9.0.0 -->\n";

    expect(conventionsMark(quoted)).toBeUndefined();
  });

  it("reads nothing from a mark carrying something that is not a number", () => {
    expect(conventionsMark("# c <!-- ticket-runner:version unknown -->\n")).toBeUndefined();
  });
});

/** One `## ` section's body, and a legible failure when the heading is gone. */
function section(doc: string, heading: string): string {
  const found = doc.split(`\n## `).find((part) => part.startsWith(`${heading}\n`));
  if (found === undefined) throw new Error(`no "## ${heading}" section in the document`);
  return found;
}
