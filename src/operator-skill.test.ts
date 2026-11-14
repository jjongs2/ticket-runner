import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    ["Note", "Notes the Run posted: defects a Stage met that belong to another Ticket or to none yet"],
  ])("glosses %s", (_term, gloss) => {
    expect(operatorSkill()).toContain(gloss);
  });
});

/** The skill's one shell block that contains `text`. */
function shellBlock(text: string): string {
  const blocks = [...operatorSkill().matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map(
    (match) => match[1] ?? "",
  );
  const found = blocks.filter((block) => block.includes(text));
  expect(found).toHaveLength(1);
  return found[0] ?? "";
}

/** A Run's log as an Operator's Run wrote it, its exit line last. */
const RECORDED = readFileSync(new URL("./testing/operator-watch/run.log", import.meta.url), "utf8");
const RECORDED_LINES = RECORDED.trimEnd().split("\n");

/** What the watch shows of the given lines of the recorded log: `<number>: <line>`. */
function shown(numbers: number[]): string[] {
  return numbers.map((number) => `${number}: ${RECORDED_LINES[number - 1]}`);
}

/** Lines `first` to `last` of the recorded log, both included. */
function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/**
 * The lines of the recorded log the skill asks to be reported: the opening and
 * the warning before it, every Ticket that ended, the Release that stopped the
 * Run, the Tickets a Stop left to finish, and the second line of a failure.
 * Every progress line between them is left out.
 */
const REPORTED = [1, 2, 3, 11, 14, 17, 18, 19, 21, 22, 23];

/** From the summary's header to the exit line, every line. */
const SUMMARY_AND_EXIT = range(24, RECORDED_LINES.length);

/**
 * The commands an Operator runs, run here on a recorded log. A cloud Host is
 * Linux, with `setsid` and GNU `tail`, so the commands are written for that.
 */
describe.runIf(process.platform === "linux")("the Operator's commands", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ticket-runner-operator-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * A `ticket-runner` that prints the recorded log but its exit line, in two
   * parts a second apart so a watch already running has to follow the file,
   * and exits as the recorded Run did. Any arguments but `run 12 14` make it
   * exit 9 instead, which the exit line would show.
   */
  function fakeRunner(): string {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(root, "first.txt"), `${RECORDED_LINES.slice(0, 12).join("\n")}\n`);
    writeFileSync(join(root, "rest.txt"), `${RECORDED_LINES.slice(12, -1).join("\n")}\n`);
    writeFileSync(
      join(bin, "ticket-runner"),
      [
        "#!/bin/sh",
        '[ "$*" = "run 12 14" ] || exit 9',
        `cat ${JSON.stringify(join(root, "first.txt"))}`,
        "sleep 1",
        `cat ${JSON.stringify(join(root, "rest.txt"))}`,
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "ticket-runner"), 0o755);
    return bin;
  }

  function start(bin: string): void {
    const command = shellBlock("setsid").replace("<arguments>", "12 14");
    execFileSync("bash", ["-c", command], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      timeout: 10_000,
    });
  }

  function watch(from: number): { lines: string[]; exited: boolean } {
    const command = shellBlock("tail -n").replace(/^from=1$/m, `from=${from}`);
    const result = spawnSync("bash", ["-c", command], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    });
    return {
      lines: result.stdout.split("\n").filter((line) => line !== ""),
      exited: result.signal === null && result.status === 0,
    };
  }

  it("start the Run detached, its output and then its exit code in the log", () => {
    start(fakeRunner());
    // The start command returned while the Run still runs; the watch waits it out.
    expect(watch(1).exited).toBe(true);
    expect(readFileSync(join(root, ".ticket-runner", "run.log"), "utf8")).toBe(RECORDED);
  });

  it("show only the reported lines, the summary and the exit line, and exits", () => {
    start(fakeRunner());
    const { lines, exited } = watch(1);
    expect(lines).toEqual(shown([...REPORTED, ...SUMMARY_AND_EXIT]));
    expect(exited).toBe(true);
  });

  it("show, re-armed one past the last line shown, only what came after it", () => {
    start(fakeRunner());
    expect(watch(1).exited).toBe(true);
    const { lines, exited } = watch(15);
    expect(lines).toEqual(shown([...REPORTED.filter((line) => line >= 15), ...SUMMARY_AND_EXIT]));
    expect(exited).toBe(true);
  });
});
