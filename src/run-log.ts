import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

/** Where one Run's transcripts live: one directory per Run, under the repo root. */
export function runLogDir(repoRoot: string, runId: string): string {
  return join(repoRoot, ".ticket-runner", "runs", runId);
}

/**
 * Where a Stage's command line, stdout, stderr and transcript are written:
 * one directory per Run, per Ticket, under the gitignored run directory.
 */
export function stageLogDir(repoRoot: string, runId: string, ticket: number): string {
  return join(runLogDir(repoRoot, runId), String(ticket));
}

/**
 * Where the fix Stage and the pass it bought write instead.
 *
 * A Stage's files are named after the Stage and emptied when it starts, so a
 * second verify would overwrite the Verdict that spent the fix budget — which
 * is the transcript a human most needs when the Ticket is handed off anyway.
 */
export function retryLogDir(repoRoot: string, runId: string, ticket: number): string {
  return join(stageLogDir(repoRoot, runId, ticket), "retry");
}

/** The file naming the Version, at the top of a Run's transcripts. */
export const VERSION_FILE = "version.txt";

/**
 * Say which Version this Run is, beside the transcripts it is about to write.
 *
 * Written before the first Stage, so a transcript always sits beside the
 * pipeline that wrote it: the Run summary names the Version too, but that is a
 * terminal the night is over for, and these files outlive it (ADR-0007).
 */
export function writeRunVersion(repoRoot: string, runId: string, version: string): void {
  const directory = runLogDir(repoRoot, runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, VERSION_FILE), `${version}\n`);
}

/**
 * What of a Stage's files a hand-off keeps: its command line, to reproduce it
 * by hand, and its transcript, to read why it did what it did. Its stdout is
 * what the transcript was parsed out of, and its stderr is the CLI's own.
 */
const KEPT_SUFFIXES = [".command", ".transcript.jsonl"];

/** One file a hand-off keeps: its name under the Ticket's, and where it is on disk. */
export interface TranscriptFile {
  /** `/`-separated, whatever the platform, since it names a file on a git branch. */
  name: string;
  path: string;
}

/**
 * The files Run `runId` wrote for `ticket` that a hand-off keeps, in name
 * order: every Stage's command line and transcript, the retries' in `retry/`,
 * and the Version the Run was, so they still name the pipeline that wrote them
 * once they are somewhere else. None when the Run wrote nothing for the Ticket.
 */
export function transcriptFiles(
  repoRoot: string,
  runId: string,
  ticket: number,
): TranscriptFile[] {
  const directory = stageLogDir(repoRoot, runId, ticket);
  if (!existsSync(directory)) return [];

  const stages = readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => KEPT_SUFFIXES.some((suffix) => name.endsWith(suffix)))
    .map((name) => ({ name: name.split(sep).join("/"), path: join(directory, name) }));
  if (stages.length === 0) return [];

  const version = join(runLogDir(repoRoot, runId), VERSION_FILE);
  const files = existsSync(version) ? [...stages, { name: VERSION_FILE, path: version }] : stages;
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A run id that sorts chronologically and is safe in a path. */
export function newRunId(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
}
