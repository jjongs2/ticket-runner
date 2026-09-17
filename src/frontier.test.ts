import { describe, expect, it } from "vitest";
import { selectFrontier } from "./frontier.js";
import type { Candidate } from "./ports/tracker.js";

function candidate(overrides: Partial<Candidate> & { number: number }): Candidate {
  return {
    title: `Ticket ${overrides.number}`,
    assignees: [],
    openBlockers: 0,
    ...overrides,
  };
}

const numbers = (candidates: Candidate[]) => candidates.map((c) => c.number);

describe("selectFrontier", () => {
  it("orders the Tickets a Run may pick by ascending number", () => {
    const { frontier } = selectFrontier([
      candidate({ number: 9 }),
      candidate({ number: 4 }),
      candidate({ number: 7 }),
    ]);

    expect(numbers(frontier)).toEqual([4, 7, 9]);
  });

  it("keeps a candidate whose blockers have all closed off the blocked list", () => {
    const selection = selectFrontier([candidate({ number: 6, openBlockers: 0 })]);

    expect(numbers(selection.frontier)).toEqual([6]);
    expect(selection.blocked).toEqual([]);
  });

  it("holds back a candidate with at least one open blocker", () => {
    const selection = selectFrontier([
      candidate({ number: 9, openBlockers: 1 }),
      candidate({ number: 4, openBlockers: 3 }),
      candidate({ number: 5 }),
    ]);

    expect(numbers(selection.frontier)).toEqual([5]);
    expect(numbers(selection.blocked)).toEqual([4, 9]);
  });

  it("reports a candidate somebody has claimed on neither side", () => {
    const selection = selectFrontier([
      candidate({ number: 4, assignees: ["octocat"] }),
      candidate({ number: 5, assignees: ["octocat"], openBlockers: 1 }),
      candidate({ number: 6 }),
    ]);

    expect(numbers(selection.frontier)).toEqual([6]);
    expect(selection.blocked).toEqual([]);
  });

  it("has nothing to pick and nothing to report when there are no candidates", () => {
    expect(selectFrontier([])).toEqual({ frontier: [], blocked: [] });
  });
});
