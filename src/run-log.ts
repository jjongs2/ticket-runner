import { join } from "node:path";

/**
 * Where a Stage's command line, stdout, stderr and transcript are written:
 * one directory per Run, per Ticket, under the gitignored run directory.
 */
export function stageLogDir(repoRoot: string, runId: string, ticket: number): string {
  return join(repoRoot, ".agent-pipeline", "runs", runId, String(ticket));
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

/** A run id that sorts chronologically and is safe in a path. */
export function newRunId(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
}
