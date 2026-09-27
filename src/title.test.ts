import { describe, expect, it } from "vitest";
import { NOTES_LIST_SCHEMA } from "./note-schema.js";
import { CODE_STAGE_JSON_SCHEMA, parseTitle, pullRequestTitle } from "./title.js";

const TICKET_TITLE = "A pull request is titled after its first commit";

describe("CODE_STAGE_JSON_SCHEMA", () => {
  it("requires a title and the Notes list, and nothing else", () => {
    expect(CODE_STAGE_JSON_SCHEMA.required).toEqual(["title", "notes"]);
    expect(CODE_STAGE_JSON_SCHEMA.properties.title.type).toBe("string");
    expect(CODE_STAGE_JSON_SCHEMA.properties.notes).toBe(NOTES_LIST_SCHEMA);
    expect(CODE_STAGE_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it("asks for the whole branch, in the convention, without the Ticket reference", () => {
    const { description } = CODE_STAGE_JSON_SCHEMA.properties.title;

    expect(description).toContain("the whole branch");
    expect(description).toContain("`<type>(<scope>): <summary>`");
    expect(description).toContain("without the `(#<n>)`");
  });
});

describe("parseTitle", () => {
  it("reads a title in the commit convention's shape", () => {
    expect(parseTitle({ title: "feat(cli): title the branch", notes: [] })).toBe(
      "feat(cli): title the branch",
    );
    expect(parseTitle({ title: "docs: say so" })).toBe("docs: say so");
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
