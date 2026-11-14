/**
 * The `notes` list as a Stage's `--json-schema` declares it, descriptions and
 * all.
 *
 * One declaration rather than one per schema, because the descriptions are what
 * a Stage actually reads: two copies would drift, and the Stage reading the
 * stale one would be the only place it showed.
 *
 * A module of its own rather than a corner of `notes.ts`, because the verdict's
 * schema carries this list too and `notes.ts` reaches the templates a Note is
 * posted with, which read a verdict. Only the shape a Stage is asked for lives
 * here, so both schemas can share it without that cycle.
 *
 * `ticket` is optional on purpose: a Stage that guesses a number puts the Note
 * on an unrelated issue, where a Stage that leaves it out gets a comment on the
 * standing Notes issue a human reads. Not knowing is an answer.
 *
 * The rest are the parts nearly every Note has anyway, asked for one by one so
 * each lands under a label of its own: a triager finds the evidence without
 * reading the whole Note, and tells one that waits on a decision from one that
 * only needs a Ticket by its `next`. `next` alone is optional, because a Stage
 * that knows neither a fix nor the decision in the way has nothing to put there.
 *
 * Each Stage reads it with one more sentence in its description, saying where a
 * defect of its own branch goes instead: the Stages that write code read
 * {@link CODE_STAGE_NOTES_LIST_SCHEMA}, and verify reads the verdict's copy.
 */
export const NOTES_LIST_SCHEMA = {
  type: "array",
  description:
    "Defects that belong to another Ticket, or to no Ticket yet. Empty when you found none, which is the ordinary case.",
  items: {
    type: "object",
    properties: {
      ticket: {
        type: "number",
        description:
          "The issue number this belongs to. Omit it unless you are sure which one.",
      },
      summary: {
        type: "string",
        description: "One short sentence naming the defect.",
      },
      evidence: {
        type: "string",
        description:
          "Where the defect is and what shows it is real: what you ran or read, what you expected and what came back.",
      },
      impact: {
        type: "string",
        description: "What breaks, and for whom.",
      },
      next: {
        type: "string",
        description:
          "The fix, or the decision a human has to take before anyone can fix it. Leave it out when there is neither.",
      },
    },
    required: ["summary", "evidence", "impact"],
    additionalProperties: false,
  },
} as const;

/**
 * What a defect the branch itself made is, in the words every Stage is told it
 * in: one declaration, so the code Stages and verify cannot drift apart on it.
 */
export const BRANCH_DEFECT =
  "A defect this branch introduced, one that behaves correctly on the base branch and wrongly here, or one in code this branch added";

/** Whose such a defect is, in the words the code Stages' schema and prompts use. */
export const OWN_DEFECT = `${BRANCH_DEFECT}, belongs to this Ticket`;

/**
 * The list as the implement and fix Stages read it: a defect their own branch
 * introduced is theirs to fix, not to list. verify reads the list with a
 * description of its own, which sends such a defect to its verdict instead.
 */
export const CODE_STAGE_NOTES_LIST_SCHEMA = {
  ...NOTES_LIST_SCHEMA,
  description: `Defects that belong to another Ticket, or to no Ticket yet. ${OWN_DEFECT}: fix it, and do not list it here. Empty when you found none, which is the ordinary case.`,
} as const;
