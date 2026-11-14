/**
 * What a pipeline pull request is titled, which is also the subject of the
 * squash commit that lands on the base branch.
 *
 * The two Stages that write code each answer a `title` for the whole branch as
 * it stands when they finish, and the latest one that counts is the title. It
 * is asked for as an answer rather than read off a commit because a commit
 * subject describes its own commit: a fix Stage that did most of a Ticket's
 * work could not retitle a branch whose first commit was already pushed without
 * rewriting it.
 *
 * The pull request body and the problem and solution the squash commit opens
 * with are answered beside the title for the same reason, and recorded the
 * same way ({@link BranchProse}).
 */

import { CODE_STAGE_NOTES_LIST_SCHEMA } from "./note-schema.js";

/**
 * What a title is asked to be, in the words both the schema and the prompts of
 * the code Stages use: one declaration, so the two cannot drift apart.
 */
export const BRANCH_TITLE =
  "one line summarising the whole branch as it stands when you finish, the work of any Stage before you included";

/**
 * The shape a commit subject and a title take, as the prompts of the code
 * Stages and the schema state it: one declaration, so they cannot drift apart.
 * The conventions document a Target carries states it to the readers the
 * pipeline does not brief.
 */
export const SUBJECT_SHAPE = "<type>(<scope>): <summary>";

/** Any {@link SUBJECT_SHAPE}; the repo's own types and scopes are CONTRIBUTING.md's business. */
const CONVENTIONAL_SUBJECT = /^[a-z]+(\([a-z0-9._-]+\))?: \S/;

/** The `(#<n>)` a commit may carry, which the squash commit's `Closes #<n>` replaces. */
const TICKET_REFERENCE = /\s*\(#\d+\)$/;

/**
 * How the schema tells a Stage to keep an answer: an empty one is how a fix
 * Stage leaves the body, problem or solution before it standing.
 */
const KEEP_EARLIER = "An empty string keeps the one an earlier Stage answered.";

/**
 * The `--json-schema` the implement and fix Stages are invoked with: the title
 * of the whole branch, the pull request body, the problem and the solution the
 * squash commit opens with, the Notes channel beside them, and why the Stage
 * ended with no new commit when it did.
 *
 * All are required, so a Stage always says something about each: an empty
 * Notes list when it found nothing, a title however little it did, an empty
 * string for a body, problem or solution it leaves as it was, and an empty
 * reason when it committed. The parsers forgive each one on its own
 * ({@link parseTitle}, {@link parseBranchProse}, `parseNotes` and
 * {@link parseNoCommitReason}), so a bad answer to one never costs the others.
 *
 * The reason is asked for in its own field because, under `--json-schema`, the
 * answer is all of the session the pipeline reads: a last message in prose is
 * only an earlier turn of the transcript. A Stage that ends with no new commit
 * hands the Ticket to a human, and the hand-off quotes the reason (#306).
 */
export const CODE_STAGE_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: `Write ${BRANCH_TITLE}: \`${SUBJECT_SHAPE}\`, without the \`(#<n>)\`. It titles the pull request and the squash commit that lands.`,
    },
    body: {
      type: "string",
      description: `The pull request body for the whole branch, without a title and without the \`Closes #<n>\` line the pipeline writes above it. ${KEEP_EARLIER}`,
    },
    problem: {
      type: "string",
      description: `The problem the branch solves, for the squash commit's body, in the shape your prompt gives. ${KEEP_EARLIER}`,
    },
    solution: {
      type: "string",
      description: `The solution, for the squash commit's body after the problem, in the shape your prompt gives. ${KEEP_EARLIER}`,
    },
    notes: CODE_STAGE_NOTES_LIST_SCHEMA,
    noCommitReason: {
      type: "string",
      description:
        "When you end with no new commit on the branch, say why in a few sentences: ending so hands the Ticket to a human, and the hand-off comment quotes this. Otherwise an empty string.",
    },
  },
  required: ["title", "body", "problem", "solution", "notes", "noCommitReason"],
  additionalProperties: false,
} as const;

/**
 * A title as it would land, or nothing when it does not count: one line in the
 * commit convention's shape.
 *
 * A trailing `(#<n>)` is taken off rather than held against it, as it is off a
 * commit subject, since the squash commit appends the pull request's own.
 */
function asTitle(candidate: string): string | undefined {
  const title = candidate.trim().replace(TICKET_REFERENCE, "");
  if (title.includes("\n")) return undefined;
  return CONVENTIONAL_SUBJECT.test(title) ? title : undefined;
}

/**
 * The title in a Stage's structured output, when it answered one that counts.
 *
 * Forgiving, as the Notes beside it are: output that is not an object, a
 * missing or blank title and one outside the convention each cost the title
 * alone, and the next candidate {@link pullRequestTitle} knows of is used.
 */
export function parseTitle(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const raw = (result as { title?: unknown }).title;
  return typeof raw === "string" ? asTitle(raw) : undefined;
}

/**
 * The prose a code Stage answers about the whole branch beside its title: the
 * pull request body, and the problem and the solution the squash commit opens
 * with. Each is absent where no Stage has answered one, and the latest one
 * answered stands until a later Stage answers it again.
 */
export interface BranchProse {
  body?: string;
  problem?: string;
  solution?: string;
}

/** The fields of {@link BranchProse}, in the order the squash commit and the prompts give them. */
export const BRANCH_PROSE_FIELDS = ["body", "problem", "solution"] as const;

/**
 * The body, the problem and the solution in a Stage's structured output, each
 * one it answered with something in it.
 *
 * Forgiving, as the title is: output that is not an object and a missing,
 * blank or non-string answer each cost that answer alone, and a blank one is
 * also how a fix Stage leaves the earlier answer standing. The lines are kept as
 * the Stage wrote them, so a list stays a list; only the ends are trimmed.
 */
export function parseBranchProse(result: unknown): BranchProse {
  const prose: BranchProse = {};
  for (const field of BRANCH_PROSE_FIELDS) {
    const answer = answeredText(result, field);
    if (answer !== undefined) prose[field] = answer;
  }
  return prose;
}

/**
 * Why a code Stage ended with no new commit, as it answered it, or nothing
 * when it gave no reason.
 *
 * Forgiving, as the title and the Notes beside it are: output that is not an
 * object and a missing, blank or non-string reason each cost the reason alone.
 * The lines are kept as the Stage wrote them; only the ends are trimmed.
 */
export function parseNoCommitReason(result: unknown): string | undefined {
  return answeredText(result, "noCommitReason");
}

/** A string field of a Stage's output, trimmed, or nothing where it holds none. */
function answeredText(result: unknown, field: string): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const raw = (result as Record<string, unknown>)[field];
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  return text === "" ? undefined : text;
}

/**
 * The pull request title, in this order of preference: the latest title a
 * Stage answered, whether in this Run or recorded by the one before it; the
 * branch's first commit subject, which is what a Stage from before titles were
 * asked for summarised the branch in; and the Ticket title.
 *
 * Each candidate counts only in the commit convention's shape. The Ticket title
 * is the one subject on the base branch allowed not to be: a branch nothing
 * wrote one conventional line about is not trusted to have one invented for it,
 * and the Ticket title at least says what the work was.
 */
export function pullRequestTitle(
  stageTitle: string | undefined,
  commits: string[],
  ticketTitle: string,
): string {
  for (const candidate of [stageTitle, commits[0]]) {
    const title = candidate === undefined ? undefined : asTitle(candidate);
    if (title !== undefined) return title;
  }
  return ticketTitle;
}
