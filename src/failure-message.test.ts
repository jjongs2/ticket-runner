import { describe, expect, it } from "vitest";
import { endSentence, printEachOutputOnce, splitMessage } from "./failure-message.js";

/** The output of the `git pull` #288's Hand-off failed on, as SSH printed it. */
const SSH_OUTPUT = [
  "git@github.com: Permission denied (publickey).",
  "fatal: Could not read from remote repository.",
  "",
  "Please make sure you have the correct access rights",
  "and the repository exists.",
].join("\n");

const PULL = "`git pull --ff-only origin main` exited 1";
const PUSH = "`git push -u origin agent/288-count-a-zombie-as-gone-in-the-tests` exited 128";

describe("splitMessage", () => {
  it("gives the command and how it exited as the line, and the rest as the output", () => {
    expect(splitMessage(`${PULL}\n${SSH_OUTPUT}`)).toEqual({ line: PULL, output: SSH_OUTPUT });
  });

  it("gives a one-line message no output", () => {
    expect(splitMessage("gh: connection reset")).toEqual({
      line: "gh: connection reset",
      output: "",
    });
  });

  it("drops the carriage return SSH ends its lines with from the line", () => {
    expect(splitMessage(`${PULL}\r\n${SSH_OUTPUT}`).line).toBe(PULL);
  });
});

describe("printEachOutputOnce", () => {
  it("prints a failure's output in full the first time, and says it is the same after", () => {
    const printed: string[] = [];
    const log = printEachOutputOnce((line) => printed.push(line));

    log(`#288 could not push: ${PUSH}\n${SSH_OUTPUT}`);
    log(`#288 could not open a draft pull request: ${PUSH}\n${SSH_OUTPUT}`);
    log(`#288 verified · 6 met`);
    log(`#288 handed off at rebase · ${PULL}\n${SSH_OUTPUT}`);
    log(`#290 could not push: ${PUSH}\n${SSH_OUTPUT}`);

    expect(printed).toEqual([
      `#288 could not push: ${PUSH}\n${SSH_OUTPUT}`,
      `#288 could not open a draft pull request: ${PUSH} · the same output as above`,
      "#288 verified · 6 met",
      `#288 handed off at rebase · ${PULL} · the same output as above`,
      `#290 could not push: ${PUSH} · the same output as above`,
    ]);
  });

  it("prints a different output in full", () => {
    const printed: string[] = [];
    const log = printEachOutputOnce((line) => printed.push(line));

    log(`#288 handed off at rebase · ${PULL}\n${SSH_OUTPUT}`);
    log(`#290 handed off at rebase · ${PULL}\nfatal: Not possible to fast-forward, aborting.`);

    expect(printed).toEqual([
      `#288 handed off at rebase · ${PULL}\n${SSH_OUTPUT}`,
      `#290 handed off at rebase · ${PULL}\nfatal: Not possible to fast-forward, aborting.`,
    ]);
  });
});

describe("endSentence", () => {
  it("adds no second full stop to an output that ends with its own", () => {
    expect(endSentence(`${PULL}\n${SSH_OUTPUT}`)).toBe(`${PULL}\n${SSH_OUTPUT}`);
  });

  it("ends a message with no full stop with one", () => {
    expect(endSentence("gh: connection reset")).toBe("gh: connection reset.");
  });
});
