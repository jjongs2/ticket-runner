import { describe, expect, it } from "vitest";
import { CODE_STAGE_NOTES_LIST_SCHEMA } from "./note-schema.js";
import { parseNotes } from "./notes.js";
import {
  CODE_STAGE_JSON_SCHEMA,
  SUBJECT_SHAPE,
  parseNoCommitReason,
  parseTitle,
  pullRequestTitle,
} from "./title.js";

const TICKET_TITLE = "A pull request is titled after its first commit";

describe("CODE_STAGE_JSON_SCHEMA", () => {
  it("requires a title, the Notes list and a reason for no new commit, and nothing else", () => {
    expect(CODE_STAGE_JSON_SCHEMA.required).toEqual(["title", "notes", "noCommitReason"]);
    expect(CODE_STAGE_JSON_SCHEMA.properties.title.type).toBe("string");
    expect(CODE_STAGE_JSON_SCHEMA.properties.noCommitReason.type).toBe("string");
    expect(CODE_STAGE_JSON_SCHEMA.properties.notes).toBe(CODE_STAGE_NOTES_LIST_SCHEMA);
    expect(CODE_STAGE_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it("asks for the whole branch, in the convention, without the Ticket reference", () => {
    const { description } = CODE_STAGE_JSON_SCHEMA.properties.title;

    expect(description).toContain("the whole branch");
    expect(description).toContain(`\`${SUBJECT_SHAPE}\``);
    expect(SUBJECT_SHAPE).toBe("<type>(<scope>): <summary>");
    expect(description).toContain("without the `(#<n>)`");
  });
});

describe("the noCommitReason field", () => {
  it("asks why in a few sentences when the Stage ends with no new commit, and otherwise for an empty string", () => {
    const { description } = CODE_STAGE_JSON_SCHEMA.properties.noCommitReason;

    expect(description).toMatch(/no new commit/);
    expect(description).toContain("a few sentences");
    expect(description).toMatch(/otherwise.*empty string/i);
  });
});

describe("parseNoCommitReason", () => {
  it("reads the reason a Stage gave, trimmed", () => {
    expect(
      parseNoCommitReason({
        title: "feat: x",
        notes: [],
        noCommitReason: "  Criterion 2 overturns ADR-0003.\n",
      }),
    ).toBe("Criterion 2 overturns ADR-0003.");
  });

  it("keeps the lines of a reason that runs over several", () => {
    expect(parseNoCommitReason({ noCommitReason: "One.\n\nTwo." })).toBe("One.\n\nTwo.");
  });

  it("yields no reason for a missing, blank or non-string field", () => {
    expect(parseNoCommitReason({ title: "feat: x", notes: [] })).toBeUndefined();
    expect(parseNoCommitReason({ noCommitReason: "" })).toBeUndefined();
    expect(parseNoCommitReason({ noCommitReason: " \n\t" })).toBeUndefined();
    expect(parseNoCommitReason({ noCommitReason: 7 })).toBeUndefined();
    expect(parseNoCommitReason({ noCommitReason: ["why"] })).toBeUndefined();
    expect(parseNoCommitReason({ noCommitReason: null })).toBeUndefined();
  });

  it("yields no reason for output that is not an object", () => {
    expect(parseNoCommitReason(undefined)).toBeUndefined();
    expect(parseNoCommitReason(null)).toBeUndefined();
    expect(parseNoCommitReason("I committed nothing")).toBeUndefined();
  });

  it("costs neither the title nor the Notes when the reason is bad", () => {
    const result = {
      title: "feat: title the branch",
      notes: [{ summary: "the log rotates twice" }],
      noCommitReason: 42,
    };

    expect(parseNoCommitReason(result)).toBeUndefined();
    expect(parseTitle(result)).toBe("feat: title the branch");
    expect(parseNotes(result)).toEqual([{ summary: "the log rotates twice" }]);
  });
});

describe("parseTitle", () => {
  it("reads a title in the commit convention's shape", () => {
    expect(parseTitle({ title: "feat(cli): title the branch", notes: [] })).toBe(
      "feat(cli): title the branch",
    );
    expect(parseTitle({ title: "docs: say so" })).toBe("docs: say so");
  });

  it("reads the title beside Notes the Notes parser would reject", () => {
    expect(parseTitle({ title: "feat: title the branch", notes: "not a list" })).toBe(
      "feat: title the branch",
    );
    expect(parseTitle({ title: "feat: title the branch", notes: [{ ticket: "x" }] })).toBe(
      "feat: title the branch",
    );
  });

  it("takes off surrounding space and a trailing Ticket reference", () => {
    expect(parseTitle({ title: "  fix: mend it (#203)\n" })).toBe("fix: mend it");
  });

  it("drops a missing, blank or non-string title", () => {
    expect(parseTitle({ notes: [] })).toBeUndefined();
    expect(parseTitle({ title: "   " })).toBeUndefined();
    expect(parseTitle({ title: 7 })).toBeUndefined();
  });

  it("drops a title outside the convention", () => {
    expect(parseTitle({ title: "Title the branch" })).toBeUndefined();
    expect(parseTitle({ title: "feat(cli) title the branch" })).toBeUndefined();
    expect(parseTitle({ title: "feat: one line\nand another" })).toBeUndefined();
  });

  it("reads nothing off output that is not an object", () => {
    expect(parseTitle(undefined)).toBeUndefined();
    expect(parseTitle(null)).toBeUndefined();
    expect(parseTitle("feat: done")).toBeUndefined();
  });
});

describe("pullRequestTitle", () => {
  it("prefers the Stage's title to the first commit subject", () => {
    expect(
      pullRequestTitle("feat: name the pipeline", ["chore: license it (#2)"], TICKET_TITLE),
    ).toBe("feat: name the pipeline");
  });

  it("falls back to the first commit subject, without its Ticket reference", () => {
    expect(
      pullRequestTitle(undefined, ["feat(tracker): compose it (#2)", "docs: x (#2)"], TICKET_TITLE),
    ).toBe("feat(tracker): compose it");
  });

  it("passes over a Stage title outside the convention", () => {
    expect(pullRequestTitle("did the thing", ["fix: mend it (#2)"], TICKET_TITLE)).toBe(
      "fix: mend it",
    );
  });

  it("falls back to the Ticket title when no candidate is in the convention", () => {
    expect(pullRequestTitle(undefined, ["wip", "feat: later (#2)"], TICKET_TITLE)).toBe(
      TICKET_TITLE,
    );
    expect(pullRequestTitle(undefined, [], TICKET_TITLE)).toBe(TICKET_TITLE);
  });
});
