import type { Candidate } from "./ports/tracker.js";

/**
 * Splitting the open `ready-for-agent` issues into the ones a Run may pick and
 * the ones an open blocker holds back.
 *
 * Nothing here talks to GitHub: the Frontier is a filter over what the
 * {@link import("./ports/tracker.js").Tracker} already reported, so the
 * selection rules are readable in one place and testable without a tracker.
 */

export interface FrontierSelection {
  /** The Frontier: unclaimed candidates whose blockers are all closed. */
  frontier: Candidate[];
  /** Unclaimed candidates an open blocker keeps off the Frontier. */
  blocked: Candidate[];
}

/**
 * Split the candidates into the Frontier and what is held back.
 *
 * Both sides come out in ascending Ticket order, so a Run always takes the
 * oldest Ticket first. A candidate somebody has claimed — this Run or another —
 * lands on neither side: it is not ours to pick and not ours to report.
 */
export function selectFrontier(candidates: Candidate[]): FrontierSelection {
  const frontier: Candidate[] = [];
  const blocked: Candidate[] = [];

  for (const candidate of [...candidates].sort((a, b) => a.number - b.number)) {
    if (candidate.assignees.length > 0) continue;
    (candidate.openBlockers === 0 ? frontier : blocked).push(candidate);
  }

  return { frontier, blocked };
}
