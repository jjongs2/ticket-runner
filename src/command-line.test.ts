import { describe, expect, it } from "vitest";
import { USAGE, readCommandLine } from "./command-line.js";

describe("the commands", () => {
  it("reads `run` as the whole Frontier, with the config's Lanes", () => {
    expect(readCommandLine(["run"])).toEqual({ kind: "work", work: { command: "run" } });
  });

  it("reads `ticket <n>` as that one Ticket", () => {
    expect(readCommandLine(["ticket", "12"])).toEqual({
      kind: "work",
      work: { command: "ticket", ticket: 12 },
    });
  });

  it("refuses `ticket` without an issue number", () => {
    const read = readCommandLine(["ticket", "twelve"]);

    expect(read.kind).toBe("refused");
    expect(read.kind === "refused" && read.message).toMatch(/^`ticket` needs an issue number/);
  });

  it("reads `init` and `stop` as themselves", () => {
    expect(readCommandLine(["init"])).toEqual({ kind: "init" });
    expect(readCommandLine(["stop"])).toEqual({ kind: "stop" });
  });

  it("refuses a command it does not have, with the usage", () => {
    const read = readCommandLine(["drain"]);

    expect(read).toEqual({ kind: "refused", message: `Unknown command \`drain\`.\n\n${USAGE}` });
  });

  it("refuses an option it does not take in one sentence, with the usage", () => {
    const read = readCommandLine(["run", "--fast"]);

    expect(read.kind).toBe("refused");
    const message = read.kind === "refused" ? read.message : "";
    expect(message.split("\n")[0]).toMatch(/--fast/);
    expect(message.endsWith(USAGE)).toBe(true);
  });

  it("answers `--help` with the usage and 0, and nothing at all with the usage and 2", () => {
    expect(readCommandLine(["--help"])).toEqual({ kind: "usage", exitCode: 0 });
    expect(readCommandLine(["run", "-h"])).toEqual({ kind: "usage", exitCode: 0 });
    expect(readCommandLine([])).toEqual({ kind: "usage", exitCode: 2 });
  });

  it("answers `--version` before anything else it was given", () => {
    expect(readCommandLine(["run", "--version"])).toEqual({ kind: "version" });
  });
});

describe("the Lane count a Run is started with", () => {
  it("reads `run --lanes <n>` as that many Lanes", () => {
    expect(readCommandLine(["run", "--lanes", "3"])).toEqual({
      kind: "work",
      work: { command: "run", lanes: 3 },
    });
  });

  it("reads the `--lanes=<n>` spelling and the option before the command alike", () => {
    expect(readCommandLine(["run", "--lanes=2"])).toMatchObject({ work: { lanes: 2 } });
    expect(readCommandLine(["--lanes", "2", "run"])).toMatchObject({ work: { lanes: 2 } });
  });

  it.each(["0", "-1", "two", "1.5", ""])("refuses `--lanes %s`", (count) => {
    const read = readCommandLine(["run", `--lanes=${count}`]);

    expect(read.kind).toBe("refused");
    expect(read.kind === "refused" && read.message).toMatch(/^`--lanes` needs a whole number/);
  });

  it("refuses `--lanes` with no count after it", () => {
    expect(readCommandLine(["run", "--lanes"]).kind).toBe("refused");
  });

  it.each([["ticket", "4"], ["init"], ["stop"]])("refuses `--lanes` on `%s`", (...command) => {
    const read = readCommandLine([...command, "--lanes", "2"]);

    expect(read.kind).toBe("refused");
    expect(read.kind === "refused" && read.message).toMatch(/^`--lanes` is for `run` only/);
  });

  it("is documented in the usage", () => {
    expect(USAGE).toMatch(/^ {2}--lanes <n> {2,}With `run`/m);
  });
});

describe("taking the pipeline out of a Target", () => {
  it("reads `remove` as asking first, and `-y` or `--yes` as going ahead", () => {
    expect(readCommandLine(["remove"])).toEqual({ kind: "remove", yes: false });
    expect(readCommandLine(["remove", "-y"])).toEqual({ kind: "remove", yes: true });
    expect(readCommandLine(["--yes", "remove"])).toEqual({ kind: "remove", yes: true });
  });

  it.each([["run"], ["ticket", "12"], ["init"], ["stop"]])(
    "refuses `--yes` with `%s`, with the usage",
    (...command) => {
      for (const yes of ["-y", "--yes"]) {
        const read = readCommandLine([...command, yes]);

        expect(read.kind).toBe("refused");
        expect(read.kind === "refused" && read.message).toMatch(/^`--yes` is for `remove` only/);
      }
    },
  );

  it("is documented in the usage in plain words", () => {
    expect(USAGE).toMatch(/^ {2}ticket-runner remove {2,}Take the pipeline out of this repository\.$/m);
    expect(USAGE).toMatch(/^ {2}-y, --yes {2,}With `remove`/m);
  });
});
