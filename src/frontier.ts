import type { Candidate } from "./ports/tracker.js";

/**
 * Splitting the open `ready-for-agent` issues into the ones a Run may pick and
 * the ones an open blocker holds back.
 *
 * Nothing here talks to GitHub: the Frontier is a filter over what the
 * {@link import("./ports/tracker.js").Tracker} already reported, so the
 * selection rules are readable in one place and testable without a tracker.
 */

/** Claimed by somebody — this Run or another — so not ours to pick. */
function unclaimed(candidate: Candidate): boolean {
  return candidate.assignees.length === 0;
}

function byNumber(a: Candidate, b: Candidate): number {
  return a.number - b.number;
}

/**
 * The Frontier: open, unclaimed candidates whose blockers are all closed, in
 * ascending Ticket order so the oldest Ticket is always picked first.
 */
export function frontier(candidates: Candidate[]): Candidate[] {
  return candidates
    .filter((candidate) => unclaimed(candidate) && candidate.openBlockers === 0)
    .sort(byNumber);
}

/**
 * The unclaimed candidates an open blocker keeps off the Frontier. A Run that
 * ends with these left over has not finished the work, only what it may reach.
 */
export function blockedCandidates(candidates: Candidate[]): Candidate[] {
  return candidates
    .filter((candidate) => unclaimed(candidate) && candidate.openBlockers > 0)
    .sort(byNumber);
}
