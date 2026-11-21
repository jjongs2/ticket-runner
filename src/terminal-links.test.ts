import { describe, expect, it } from "vitest";
import { linkNumbers } from "./terminal-links.js";

const REPOSITORY = "acme/shop";

/** `#<n>` as the terminal is handed it: an OSC 8 hyperlink to the issue. */
function link(number: number): string {
  return `\x1b]8;;https://github.com/acme/shop/issues/${number}\x1b\\#${number}\x1b]8;;\x1b\\`;
}

describe("linkNumbers", () => {
  it("links every #N on the line to its issue on the Target", () => {
    expect(linkNumbers("  merged   #3 Run: drain the Frontier (PR #12)", REPOSITORY)).toBe(
      `  merged   ${link(3)} Run: drain the Frontier (PR ${link(12)})`,
    );
  });

  it("links a number at the very start of a line", () => {
    expect(linkNumbers("#4 claimed · agent/4-planning-guards", REPOSITORY)).toBe(
      `${link(4)} claimed · agent/4-planning-guards`,
    );
  });

  it("links a number a Ticket's title quotes", () => {
    expect(linkNumbers("  merged   #5 Follow up on #2, then #7. (PR #9)", REPOSITORY)).toBe(
      `  merged   ${link(5)} Follow up on ${link(2)}, then ${link(7)}. (PR ${link(9)})`,
    );
  });

  it("leaves a number written straight after a letter, a digit or a slash plain", () => {
    for (const line of ["owner/repo#12", "a#12", "3#12", "가#12"]) {
      expect(linkNumbers(line, REPOSITORY)).toBe(line);
    }
  });

  it("links a number an ellipsis follows, which only the summary can tell was cut", () => {
    expect(linkNumbers("see #128… and #12…more", REPOSITORY)).toBe(
      `see ${link(128)}… and ${link(12)}…more`,
    );
  });

  it("leaves a # with no number after it alone", () => {
    expect(linkNumbers("# heading and #x", REPOSITORY)).toBe("# heading and #x");
  });

  it("leaves every number plain where GitHub could not name the Target", () => {
    const line = "  merged   #3 Run: drain the Frontier (PR #12)";

    expect(linkNumbers(line, undefined)).toBe(line);
  });
});
