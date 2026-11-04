import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPERATOR_SKILL_PATH, operatorSkill } from "./operator-skill.js";
import { bareAcronymPRs, capitalisedDroppedWords } from "./testing/dropped-words.js";

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

  /**
   * A Target carries no glossary, so the skill writes a word the glossary
   * dropped as the ordinary word it is, and says each term it does list in a
   * few words where it first uses it.
   */
  it("writes the words the glossary dropped as ordinary words", () => {
    expect(capitalisedDroppedWords(operatorSkill())).toEqual([]);
    expect(bareAcronymPRs(operatorSkill())).toEqual([]);
  });

  it.each([
    ["Host", "the machine the pipeline runs on"],
    ["Run", "one invocation of the pipeline"],
    ["Ticket", "issues each sized for one session of work"],
    ["Stop", "finish the Tickets it holds and take no more"],
    ["Stage", "a Claude Code session a Run started for a single purpose"],
    ["Operator", "the Claude session a human opened on this repository"],
    ["Target", "the repository a Run takes its work from and merges into"],
    ["Check", "a command the pipeline runs itself on a Ticket's code"],
    ["Hand-off", "handed off (given to a human to carry on)"],
    ["Release", "released (given back for a later Run to take up again)"],
  ])("glosses %s", (_term, gloss) => {
    expect(operatorSkill()).toContain(gloss);
  });
});
