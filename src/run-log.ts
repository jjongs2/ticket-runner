import { join } from "node:path";

/**
 * Where a Stage's command line, stdout, stderr and transcript are written:
 * one directory per Run, per Ticket, under the gitignored run directory.
 */
export function stageLogDir(repoRoot: string, runId: string, ticket: number): string {
  return join(repoRoot, ".agent-pipeline", "runs", runId, String(ticket));
}

/** A run id that sorts chronologically and is safe in a path. */
export function newRunId(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
}
