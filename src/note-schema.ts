/**
 * The `notes` list as a Stage's `--json-schema` declares it, descriptions and
 * all.
 *
 * One declaration rather than one per schema, because the descriptions are what
 * a Stage actually reads: two copies would drift, and the Stage reading the
 * stale one would be the only place it showed.
 *
 * A module of its own rather than a corner of `notes.ts`, because the Verdict's
 * schema carries this list too and `notes.ts` reaches the templates a Note is
 * posted with, which read a Verdict. Only the shape a Stage is asked for lives
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
