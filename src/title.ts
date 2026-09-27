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
 */

import { NOTES_LIST_SCHEMA } from "./note-schema.js";

/**
 * What a title is asked to be, in the words both the schema and the prompts of
 * the code Stages use: one declaration, so the two cannot drift apart.
 */
export const BRANCH_TITLE =
  "one line summarising the whole branch as it stands when you finish, the work of any Stage before you included";

/** Any `<type>(<scope>): <summary>`; the repo's own types and scopes are CONTRIBUTING.md's business. */
const CONVENTIONAL_SUBJECT = /^[a-z]+(\([a-z0-9._-]+\))?: \S/;

/** The `(#<n>)` a branch commit carries, which the squash commit's `Closes #<n>` replaces. */
const TICKET_REFERENCE = /\s*\(#\d+\)$/;

/**
 * The `--json-schema` the implement and fix Stages are invoked with: the title
 * of the whole branch, and the Notes channel beside it.
 *
 * Both are required, so a Stage always says something about each: an empty
 * Notes list when it found nothing, and a title however little it did. The
 * parsers forgive either one on its own ({@link parseTitle} and `parseNotes`),
 * so a bad title never costs the Notes and bad Notes never cost the title.
 */
export const CODE_STAGE_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: `Write ${BRANCH_TITLE}: \`<type>(<scope>): <summary>\`, without the \`(#<n>)\`. It titles the pull request and the squash commit that lands.`,
    },
    notes: NOTES_LIST_SCHEMA,
  },
  required: ["title", "notes"],
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
