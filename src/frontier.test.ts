import { describe, expect, it } from "vitest";
import { blockedCandidates, frontier } from "./frontier.js";
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

describe("frontier", () => {
  it("orders the Tickets a Run may pick by ascending number", () => {
    const picked = frontier([candidate({ number: 9 }), candidate({ number: 4 }), candidate({ number: 7 })]);

    expect(numbers(picked)).toEqual([4, 7, 9]);
  });

  it("drops a candidate that somebody has already claimed", () => {
    const picked = frontier([
      candidate({ number: 4, assignees: ["octocat"] }),
      candidate({ number: 5 }),
    ]);

    expect(numbers(picked)).toEqual([5]);
  });

  it("drops a candidate with at least one open blocker", () => {
    const picked = frontier([
      candidate({ number: 4, openBlockers: 1 }),
      candidate({ number: 5, openBlockers: 2 }),
    ]);

    expect(picked).toEqual([]);
  });

  it("keeps a candidate whose blockers have all closed", () => {
    const picked = frontier([candidate({ number: 6, openBlockers: 0 })]);

    expect(numbers(picked)).toEqual([6]);
  });
});

describe("blockedCandidates", () => {
  it("reports the unclaimed candidates an open blocker holds back", () => {
    const held = blockedCandidates([
      candidate({ number: 9, openBlockers: 1 }),
      candidate({ number: 4, openBlockers: 3 }),
      candidate({ number: 5 }),
    ]);

    expect(numbers(held)).toEqual([4, 9]);
  });

  it("does not report a claimed candidate as blocked", () => {
    const held = blockedCandidates([
      candidate({ number: 4, openBlockers: 1, assignees: ["octocat"] }),
    ]);

    expect(held).toEqual([]);
  });
});
