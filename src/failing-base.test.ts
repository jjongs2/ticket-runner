import { describe, expect, it } from "vitest";
import { BaseBranchChecks } from "./failing-base.js";
import type { RoutedNote } from "./notes.js";

const COMMIT = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

const note: RoutedNote = {
  origin: 2,
  stage: "pipeline",
  issue: 200,
  opened: true,
  summary: "The Base branch `main` fails `npm test`.",
};

describe("the Note about a commit", () => {
  it("is posted by the first Ticket to ask, and by none after it", async () => {
    const checks = new BaseBranchChecks();
    let posts = 0;
    const post = async () => {
      posts += 1;
      return note;
    };

    const answers = await Promise.all([checks.noteOnce(COMMIT, post), checks.noteOnce(COMMIT, post)]);

    expect(answers).toEqual([note, undefined]);
    expect(posts).toBe(1);
  });

  it("is posted again by a Ticket that was waiting on a post that failed", async () => {
    const checks = new BaseBranchChecks();
    let posts = 0;
    const post = async () => {
      posts += 1;
      if (posts === 1) throw new Error("GitHub is down");
      return note;
    };

    const [first, second] = await Promise.allSettled([
      checks.noteOnce(COMMIT, post),
      checks.noteOnce(COMMIT, post),
    ]);

    expect(first.status).toBe("rejected");
    expect(second).toEqual({ status: "fulfilled", value: note });
    expect(posts).toBe(2);
  });
});
