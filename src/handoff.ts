/**
 * The hand-off comments a Ticket is already carrying when it is claimed.
 *
 * A hand-off is current for exactly as long as a human holds the Ticket. Once
 * the Ticket is relabelled and a Run takes it again, the comment still reads as
 * the last word on it — and on a Ticket that then merges it is the last thing
 * on a closed issue, because the progress comment is edited in place above it
 * and the merge writes nothing below. So the Claim marks every hand-off comment
 * on the Ticket as history on its way past.
 *
 * Marked, not removed: the failure, the location and the evidence are worth
 * reading afterwards, and an edit notifies nobody, which is what makes this
 * cheap enough to do to every one of them. `docs/templates/handoff-comment.md`
 * is the source of truth for the shape.
 */

import type { IssueComment, Tracker } from "./ports/tracker.js";
import { HANDOFF_MARKER, findMarkedComments, handoffTakenComment } from "./templates.js";

/**
 * Every hand-off comment the Ticket is still carrying as current, each with the
 * body that would mark it as history.
 *
 * One question, asked twice: it is what the Claim edits, and it is also what
 * says a human has been holding the Ticket since the last Run put it down.
 */
function unmarkedHandoffs(
  comments: IssueComment[],
): { comment: IssueComment; marked: string }[] {
  return findMarkedComments(comments, HANDOFF_MARKER).flatMap((comment) => {
    const marked = handoffTakenComment(comment.body);
    return marked === undefined ? [] : [{ comment, marked }];
  });
}

/**
 * Whether a human has been holding the Ticket since the last Run put it down.
 *
 * Asked of the comments as they were when the Ticket was claimed, so the Run
 * marking them now still sees the hand-off it is answering.
 */
export function carriesCurrentHandoff(comments: IssueComment[]): boolean {
  return unmarkedHandoffs(comments).length > 0;
}

export interface HandoffOptions {
  tracker: Tracker;
  ticket: number;
  /** The Ticket's comments as they were when it was claimed. */
  comments: IssueComment[];
  log?: (line: string) => void;
}

/**
 * Mark every hand-off comment on a Ticket as history, the Ticket having just
 * been taken again.
 *
 * Nothing here throws. This is a courtesy to whoever reads the Ticket next, not
 * part of how it is decided, and a Ticket must not be handed off or ended
 * because GitHub would not take an edit. A comment already marked costs no
 * tracker call, so claiming a Ticket twice does not stack the line; one the
 * tracker gave no id for cannot be edited at all and is passed over, exactly as
 * the progress comment treats one.
 */
export async function markHandoffsTaken({
  tracker,
  ticket,
  comments,
  log,
}: HandoffOptions): Promise<void> {
  for (const { comment, marked } of unmarkedHandoffs(comments)) {
    if (comment.id === undefined) continue;

    try {
      await tracker.updateComment(comment.id, marked);
    } catch (error) {
      log?.(
        `#${ticket} could not mark a hand-off comment as history: ${(error as Error).message}`,
      );
    }
  }
}
