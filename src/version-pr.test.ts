import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { versionNotes, versionPrRefusals } from "./version-pr.js";

/** One Version's notes, in the shape `docs/templates/version-notes.md` asks for. */
const NOTES = `### Lanes

- A Run takes \`lanes\` Tickets at once, default one (#82, #83)

### After upgrading

- nothing`;

/** A changelog in the template's shape, carrying a section per number given. */
function changelog(...numbers: string[]): string {
  return ["# Changelog", "", ...numbers.map(section)].join("\n");
}

/** One section, as the Version PR writes it into the changelog. */
function section(number: string): string {
  return `## ${number} (2026-09-20)\n\n${NOTES}\n`;
}

/** This repository's own changelog, which the tag workflow publishes from. */
const CHANGELOG = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

/**
 * The shape `docs/templates/version-notes.md` gives, with its fields filled in.
 * Both functions read that shape, so the template is what the fixtures below
 * are measured against: a heading renamed there and nowhere else fails a test.
 */
function templateSection(number: string): string {
  const template = readFileSync(
    new URL("../docs/templates/version-notes.md", import.meta.url),
    "utf8",
  );
  const shape: string[] = [];
  for (const line of template.split("\n")) {
    // The shape is the headings, the list items and the blank lines between
    // them; the prose explaining it starts at the first line that is none.
    if (!/^(#{2,3} |- |$)/.test(line)) break;
    shape.push(line);
  }
  return shape.join("\n").trim().replace("<number>", number).replace("<yyyy-mm-dd>", "2026-09-20");
}

describe("the notes a Version published", () => {
  it("returns a Version's section without its number heading", () => {
    expect(versionNotes(changelog("0.4.0", "0.3.1"), "0.4.0")).toBe(NOTES);
  });

  it("returns the oldest section, which no heading follows", () => {
    expect(versionNotes(changelog("0.4.0", "0.3.1", "0.3.0"), "0.3.0")).toBe(NOTES);
  });

  it("returns nothing when the changelog has no section for the number", () => {
    expect(versionNotes(changelog("0.4.0", "0.3.1"), "0.5.0")).toBeUndefined();
  });

  it("reads a heading whose number carries no date", () => {
    expect(versionNotes(`# Changelog\n\n## 0.4.0\n\n${NOTES}\n`, "0.4.0")).toBe(NOTES);
  });

  it("tells one number from another it is the head of", () => {
    expect(versionNotes(changelog("0.4.10"), "0.4.1")).toBeUndefined();
  });

  it("returns a section written in the template's shape", () => {
    const template = templateSection("0.4.0");
    expect(versionNotes(`# Changelog\n\n${template}\n`, "0.4.0")).toBe(
      template.split("\n").slice(2).join("\n"),
    );
  });

  it("returns the notes of every Version this repository has cut", () => {
    for (const number of ["0.1.0", "0.1.1", "0.2.0", "0.3.0", "0.3.1"]) {
      expect(versionNotes(CHANGELOG, number)).toContain("### After upgrading");
    }
    // The body GitHub published for that Version, to the character.
    expect(versionNotes(CHANGELOG, "0.2.0")).toBe(`### Any Target

- \`init\` sets a Target up and reports what only a human can (#71)
- A Run refuses a Target \`init\` has not set up (#72)
- A Run works against the Target's Base branch; \`baseBranch\` overrides (#70)

### After upgrading

- Run \`agent-pipeline init\` once in every Target; a Run now refuses one without it.`);
  });
});

/** A Version PR that cuts `0.4.0`, with everything about it right. */
function versionPr(over: Partial<Parameters<typeof versionPrRefusals>[0]> = {}) {
  return {
    number: "0.4.0",
    baseNumber: "0.3.1",
    lockNumber: "0.4.0",
    tags: ["v0.1.0", "v0.3.1", "v0.3.0"],
    changelog: changelog("0.4.0", "0.3.1"),
    ...over,
  };
}

describe("judging a pull request that changes the number", () => {
  it("lets a pull request that leaves the number alone through", () => {
    expect(
      versionPrRefusals({
        number: "0.3.1",
        baseNumber: "0.3.1",
        lockNumber: "0.1.0",
        tags: ["v0.3.1"],
        changelog: "",
      }),
    ).toEqual([]);
  });

  it("lets a Version PR that raises the number, the lock and the changelog through", () => {
    expect(versionPrRefusals(versionPr())).toEqual([]);
  });

  it("refuses a number no higher than the highest tag", () => {
    expect(versionPrRefusals(
        versionPr({ number: "0.3.0", lockNumber: "0.3.0", changelog: changelog("0.3.0") }),
      )).toEqual([
      "`0.3.0` is not higher than every Version tag; `v0.3.1` exists.",
    ]);
  });

  it("refuses a number the highest tag already carries", () => {
    expect(
      versionPrRefusals(versionPr({ number: "0.3.1", lockNumber: "0.3.1", baseNumber: "0.3.0" })),
    ).toEqual(["`0.3.1` is not higher than every Version tag; `v0.3.1` exists."]);
  });

  it("compares numbers by their parts, not as text", () => {
    const tenth = versionPr({
      number: "0.10.0",
      lockNumber: "0.10.0",
      changelog: changelog("0.10.0"),
    });
    expect(versionPrRefusals(tenth)).toEqual([]);
  });

  it("weighs only tags that name a Version", () => {
    const tagged = versionPr({ tags: ["v0.3.1", "a-tag-of-somebody-else's", "v9-rc"] });
    expect(versionPrRefusals(tagged)).toEqual([]);
  });

  it("refuses a lock file that disagrees with the number", () => {
    expect(versionPrRefusals(versionPr({ lockNumber: "0.3.1" }))).toEqual([
      "`package-lock.json` says `0.3.1`, not `0.4.0`.",
    ]);
  });

  it("refuses a number the changelog has no section for", () => {
    expect(versionPrRefusals(versionPr({ changelog: changelog("0.3.1") }))).toEqual([
      "`CHANGELOG.md` has no `## 0.4.0` section.",
    ]);
  });

  it("refuses a section that does not say what to do after upgrading", () => {
    const withoutHeading = changelog("0.4.0").replace("### After upgrading\n\n- nothing\n", "");
    expect(versionPrRefusals(versionPr({ changelog: withoutHeading }))).toEqual([
      "The `0.4.0` section of `CHANGELOG.md` has no `### After upgrading` heading.",
    ]);
  });

  it("returns every reason a pull request may not merge at once", () => {
    expect(
      versionPrRefusals(versionPr({ number: "0.2.0", lockNumber: "0.1.0", changelog: "" })),
    ).toEqual([
      "`0.2.0` is not higher than every Version tag; `v0.3.1` exists.",
      "`package-lock.json` says `0.1.0`, not `0.2.0`.",
      "`CHANGELOG.md` has no `## 0.2.0` section.",
    ]);
  });

  it("lets a section written in the template's shape through", () => {
    const template = versionPr({ changelog: `# Changelog\n\n${templateSection("0.4.0")}\n` });
    expect(versionPrRefusals(template)).toEqual([]);
  });
});
