import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VERSION_FILE,
  newRunId,
  retryLogDir,
  runLogDir,
  stageLogDir,
  transcriptFiles,
  writeRunVersion,
} from "./run-log.js";

const RUN_ID = "2026-09-17T09-00-00-000";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "ticket-runner-run-log-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("where a Run writes", () => {
  it("gives each Run a directory, and each of its Tickets one inside it", () => {
    expect(runLogDir(repoRoot, RUN_ID)).toBe(
      join(repoRoot, ".ticket-runner", "runs", RUN_ID),
    );
    expect(stageLogDir(repoRoot, RUN_ID, 8)).toBe(join(runLogDir(repoRoot, RUN_ID), "8"));
    expect(retryLogDir(repoRoot, RUN_ID, 8)).toBe(join(stageLogDir(repoRoot, RUN_ID, 8), "retry"));
  });
});

describe("the Version beside the transcripts", () => {
  it("names the Version at the top of the Run's own directory", () => {
    writeRunVersion(repoRoot, RUN_ID, "0.4.0+331d79c");

    expect(readFileSync(join(runLogDir(repoRoot, RUN_ID), VERSION_FILE), "utf8")).toBe(
      "0.4.0+331d79c\n",
    );
  });

  it("writes it into a directory no Stage has created yet", () => {
    // The Run writes this before its first Stage, so nothing else has been
    // there to make the directory for it.
    expect(() => writeRunVersion(repoRoot, RUN_ID, "0.4.0")).not.toThrow();
  });
});

describe("the files a hand-off keeps", () => {
  /** Write `files` under the Ticket's directory of this Run. */
  function write(ticket: number, files: string[]): void {
    for (const name of files) {
      const path = join(stageLogDir(repoRoot, RUN_ID, ticket), name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "");
    }
  }

  it("are each Stage's command line and transcript, the retries' and the Version with them", () => {
    writeRunVersion(repoRoot, RUN_ID, "0.4.0");
    write(8, [
      "verify.command",
      "verify.stdout",
      "verify.stderr",
      "verify.transcript.jsonl",
      "retry/fix.command",
      "retry/fix.transcript.jsonl",
    ]);

    const files = transcriptFiles(repoRoot, RUN_ID, 8);

    expect(files.map(({ name }) => name)).toEqual([
      "retry/fix.command",
      "retry/fix.transcript.jsonl",
      "verify.command",
      "verify.transcript.jsonl",
      "version.txt",
    ]);
    expect(files[0]?.path).toBe(join(retryLogDir(repoRoot, RUN_ID, 8), "fix.command"));
  });

  it("are none for a Ticket the Run ran no Stage of, whatever its other Tickets left", () => {
    writeRunVersion(repoRoot, RUN_ID, "0.4.0");
    write(9, ["implement.command"]);

    expect(transcriptFiles(repoRoot, RUN_ID, 8)).toEqual([]);
  });
});

describe("a run id", () => {
  it("sorts chronologically and is safe in a path", () => {
    expect(newRunId(new Date("2026-09-17T09:00:00.000Z"))).toBe(RUN_ID);
  });
});
