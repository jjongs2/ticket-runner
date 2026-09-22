import { describe, expect, it } from "vitest";
import { NOTES_LIST_SCHEMA } from "./note-schema.js";
import { NOTES_JSON_SCHEMA } from "./notes.js";
import { VERDICT_JSON_SCHEMA } from "./verdict.js";

describe("NOTES_LIST_SCHEMA", () => {
  it("asks for a ticket and a note, and requires only the note", () => {
    expect(Object.keys(NOTES_LIST_SCHEMA.items.properties)).toEqual(["ticket", "note"]);
    expect(NOTES_LIST_SCHEMA.items.required).toEqual(["note"]);
  });

  it("promises a Stage nothing about issue titles", () => {
    expect(NOTES_LIST_SCHEMA.items.properties.note.description).not.toContain("title");
  });

  it("is the one declaration both the Stages that write and the one that grades read", () => {
    expect(NOTES_JSON_SCHEMA.properties.notes).toBe(NOTES_LIST_SCHEMA);
    expect(VERDICT_JSON_SCHEMA.properties.notes).toBe(NOTES_LIST_SCHEMA);
  });
});
