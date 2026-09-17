import type { Issue } from "./ports/tracker.js";

/**
 * The guards a candidate passes before a Run claims it.
 *
 * Planning is human work and goes wrong in known ways: a Spec offered as a
 * Ticket, a Ticket with nothing for verify to grade, blockers written into the
 * body that GitHub knows nothing about (ADR-0003). Each of those produces a
 * Ticket the pipeline would take and then fail on, so the cheaper answer is to
 * pass it over and say why.
 *
 * Nothing here talks to GitHub: the guards read the issue the
 * {@link import("./ports/tracker.js").Tracker} already reported, so what counts
 * as a usable Ticket is readable in one place.
 */

/** Why a candidate was passed over instead of claimed. */
export type SkipReason = Refusal | GuardReason;

/**
 * An issue that is nobody's to take: already claimed, or never offered. A Run
 * filters both out before it gets here, so these are what `ticket <n>` hits
 * when it names an issue by hand.
 */
export type Refusal = "claimed" | "not-ready";

/** A Planning defect, which is worth exactly one warning comment. */
export type GuardReason = "spec" | "no-criteria" | "body-only-blockers";

/** Keyed rather than listed, so a new reason cannot be left out of it silently. */
const GUARD_REASONS: Record<GuardReason, true> = {
  spec: true,
  "no-criteria": true,
  "body-only-blockers": true,
};

/** Whether the skip is something to warn the humans about on the issue. */
export function isGuardReason(reason: SkipReason): reason is GuardReason {
  return reason in GUARD_REASONS;
}

/**
 * The first reason this issue may not be claimed, or `undefined` to take it.
 *
 * Order matters: an issue nobody offered the pipeline is never commented on,
 * and a Spec is named a Spec rather than whatever else is unlike a Ticket
 * about it.
 */
export function skipReason(issue: Issue, readyForAgent: string): SkipReason | undefined {
  if (issue.assignees.length > 0) return "claimed";
  if (!issue.labels.includes(readyForAgent)) return "not-ready";
  if (issue.subIssues > 0) return "spec";
  if (!hasCriteria(issue)) return "no-criteria";
  if (bodyOnlyBlockers(issue).length > 0) return "body-only-blockers";
  return undefined;
}

/** An unchecked task list item, which is what Acceptance Criteria are made of. */
const UNCHECKED_BOX = /^[ \t]*[-*+] \[ \]/m;

/** Triage posts its brief as a comment, so criteria are not always in the body. */
function hasCriteria(issue: Issue): boolean {
  return [issue.body, ...issue.comments.map((comment) => comment.body)].some((text) =>
    UNCHECKED_BOX.test(text),
  );
}

/**
 * The issues the body claims block this one that GitHub does not agree block
 * it. The answer is only ever used to reject the Ticket: an edge the body
 * alone knows about is not an edge (ADR-0003).
 */
function bodyOnlyBlockers(issue: Issue): number[] {
  return bodyBlockerReferences(issue.body).filter(
    (number) => !issue.blockedBy.includes(number),
  );
}

/** `#12`, but not the `other/repo#12` this repo cannot compare numbers with. */
const ISSUE_REFERENCE = /(?<![\w/])#(\d+)\b/g;
const LIST_ITEM = /^\s*[-*+]\s/;
/** Whatever a heading, a list item or bold text puts in front of the words. */
const DECORATION = /^[\s>#*_-]+/;

/**
 * Every `#<n>` a body's `Blocked by` section names.
 *
 * A body says it one of two ways, and the section ends where that way ends: an
 * inline `Blocked by: #3` is over at the end of its own line, and a `## Blocked
 * by` heading is over at the end of the one list under it. Reading any further
 * would take the Acceptance Criteria — a list of `#<n>`-quoting checkboxes, two
 * blank lines below — for blockers and reject a Ticket Planning got right.
 * Issue references elsewhere in the body are prose: a Parent, a follow-up, a
 * duplicate.
 */
function bodyBlockerReferences(body: string): number[] {
  const lines = body.split("\n");
  const announcement = lines.findIndex(announcesBlockers);
  if (announcement === -1) return [];

  const inline = issueReferences(lines[announcement] as string);
  if (inline.length > 0) return inline;

  const references: number[] = [];
  let listStarted = false;
  for (const line of lines.slice(announcement + 1)) {
    if (!listStarted && line.trim() === "") continue;
    if (!LIST_ITEM.test(line)) break;
    listStarted = true;
    references.push(...issueReferences(line));
  }

  return references;
}

function announcesBlockers(line: string): boolean {
  return /^blocked[ -]by\b/i.test(line.replace(DECORATION, ""));
}

function issueReferences(line: string): number[] {
  return [...line.matchAll(ISSUE_REFERENCE)].map((match) =>
    Number.parseInt(match[1] as string, 10),
  );
}
