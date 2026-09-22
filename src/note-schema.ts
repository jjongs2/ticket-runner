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
      note: {
        type: "string",
        description:
          "What you found and why it matters, in plain sentences. Open with one short sentence that names the finding and put the detail after it. No checkboxes.",
      },
    },
    required: ["note"],
    additionalProperties: false,
  },
} as const;
