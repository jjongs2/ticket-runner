import { describe, expect, it } from "vitest";
import {
  PLAIN,
  colourWanted,
  lineColour,
  terminalPaint,
  withoutColour,
} from "./terminal-colour.js";
import { linkNumbers } from "./terminal-links.js";

/** `#<n>` as a terminal is handed it, a link to that issue on `acme/shop`. */
function link(number: number): string {
  return `\x1b]8;;https://github.com/acme/shop/issues/${number}\x1b\\#${number}\x1b]8;;\x1b\\`;
}

/** The same link, bright blue at full intensity. */
function blue(number: number): string {
  return `\x1b[94m${link(number)}\x1b[0m`;
}

describe("lineColour", () => {
  it.each([
    "#5 handed off at verify · 1 of 5 criteria unmet",
    "#5 handed off at pr, but the hand-off was cut short · gh: Bad Gateway (HTTP 502)",
    "#5 failed outside the hand-off path: boom",
    "#5 has a state file this version cannot use, written by 0.9.0; it and the claim are left alone",
  ])("reds a line that asks for action on its Ticket now: %s", (line) => {
    expect(lineColour(line)).toBe("red");
  });

  it("greens a merge", () => {
    expect(lineColour("#5 merged · PR #12")).toBe("green");
  });

  it.each([
    "ticket-runner 0.6.7 run 2026-11-24T10-00-00-000 · 1 lane",
    "ticket-runner 0.6.7+331d79c.dirty run r1 · 2 lanes · #4 #5",
    "the clone was shallow, so its full history was fetched",
    "#5 claimed",
    "#5 resumed from claimed",
    "#5 resumed from implemented · agent/5-name-it",
    "#5 taken from the top, still claimed",
    "#5 keeps agent/5 · agent/5 is already on the remote",
    "#5 noted on #9",
    "#5 noted on #31 for triage",
    "opened #31 to gather Notes for triage",
    "#5 was resumable, but agent/5 is neither in /w nor on the remote",
  ])("dims the Run's own bookkeeping: %s", (line) => {
    expect(lineColour(line)).toBe("dim");
  });

  it.each([
    "#5 implemented · agent/5-name-it",
    "#5 verified · 1 of 5 criteria unmet",
    "#5 fixing · 1 of 5 criteria unmet",
    "#5 rebased onto main first",
    "#5 resolving a rebase conflict",
    "#5 released at implement · rate limit · agent/5",
    "#5 stopped the Run · rate limit",
    "#5 could not push agent/5: rejected",
    "#5 could not be handed off at pr · gh: Bad Gateway",
    "#5 handed off, but clearing its state file failed: boom",
    "#5 merged, but cleaning up failed: boom",
    "#5 left to finish · stopped",
    "#5 skipped · no-criteria",
    "#5 stays claimed for the next Run to resume, as the claim could not come off: boom",
    "A newer version is out: 0.9.0, and this is 0.6.7 — upgrade with `npm install -g ticket-runner`.",
    "transcripts of a handed-off Ticket are kept on the remote",
  ])("leaves a line to read in the default colour: %s", (line) => {
    expect(lineColour(line)).toBeUndefined();
  });
});

describe("terminalPaint", () => {
  it("colours a line whole, outside its links, and every link blue at full intensity", () => {
    const paint = terminalPaint("acme/shop", true);

    expect(paint("#5 claimed", "dim")).toBe(`${blue(5)}\x1b[2m claimed\x1b[0m`);
    expect(paint("#5 merged · PR #12", "green")).toBe(
      `${blue(5)}\x1b[32m merged · PR \x1b[0m${blue(12)}`,
    );
    expect(paint("#5 verified · 4 met")).toBe(`${blue(5)} verified · 4 met`);
  });

  it("links before it colours, so a number after a colour code is still linked", () => {
    const paint = terminalPaint("acme/shop", true);

    // Coloured first, `\x1b[2m#5` would put an `m` before the number and the
    // link rule would see none.
    expect(paint("#5", "dim")).toBe(blue(5));
  });

  it("opens and resets the colour on each line of a line that spans several", () => {
    const paint = terminalPaint("acme/shop", true);

    expect(paint("#5 handed off at rebase · failed\nfatal: no\n\nend", "red")).toBe(
      `${blue(5)}\x1b[31m handed off at rebase · failed\x1b[0m\n\x1b[31mfatal: no\x1b[0m\n\n\x1b[31mend\x1b[0m`,
    );
  });

  it("links and colours nothing else with colour off", () => {
    const paint = terminalPaint("acme/shop", false);

    expect(paint("#5 merged · PR #12", "green")).toBe(linkNumbers("#5 merged · PR #12", "acme/shop"));
  });

  it("colours but links nothing where GitHub could not name the Target", () => {
    expect(terminalPaint(undefined, true)("#5 claimed", "dim")).toBe("\x1b[2m#5 claimed\x1b[0m");
  });

  it("gives back the linked line once its colour codes are taken out", () => {
    const line = "#5 handed off at verify · see #12 and acme/other#3";
    expect(withoutColour(terminalPaint("acme/shop", true)(line, "red"))).toBe(
      terminalPaint("acme/shop", false)(line, "red"),
    );
  });
});

describe("PLAIN", () => {
  it("is the text as it is", () => {
    expect(PLAIN("#5 merged · PR #12", "green")).toBe("#5 merged · PR #12");
  });
});

describe("colourWanted", () => {
  it.each([
    [{}, true],
    [{ NO_COLOR: "" }, true],
    [{ NO_COLOR: "1" }, false],
    [{ NO_COLOR: "0" }, false],
  ])("with %o is %s", (env, wanted) => {
    expect(colourWanted(env)).toBe(wanted);
  });
});
