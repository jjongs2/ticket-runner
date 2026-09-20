import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where one Run's transcripts live: one directory per Run, under the repo root. */
export function runLogDir(repoRoot: string, runId: string): string {
  return join(repoRoot, ".agent-pipeline", "runs", runId);
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

/** A run id that sorts chronologically and is safe in a path. */
export function newRunId(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
}
