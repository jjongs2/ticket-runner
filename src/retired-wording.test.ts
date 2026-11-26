import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The pipeline once ran its Checks on a Ticket's branch, and a failing one
 * there spent the fix budget. It runs none there now (ADR-0005's amendment),
 * so nothing it ships may still describe that: not a page, a template, a
 * prompt, nor a code comment a later change would trust. The CHANGELOG and the
 * ADRs keep their history, so they are not read.
 */
const ROOT = join(import.meta.dirname, "..");

const SHIPPED = ["src", "docs/templates", "docs/agents", "wiki/en", "wiki/ko", ".claude/skills"];
const PAGES = ["README.md", "README.ko.md", "GLOSSARY.md", "CONTRIBUTING.md"];

/** The wordings only a Check on the Ticket's branch gave reason to write. */
const RETIRED: readonly RegExp[] = [
  /fails? the Check the Ticket's branch failed/i,
  /fix Stage is told which it is mending/i,
  /before (its|their) Checks/i,
  /\bat checks\b/i,
  /told (that )?the Checks passed/i,
  /Check (on|of) (a|the) Ticket's branch (fails|failed|failing)/i,
  /failing Check (on|of) (a|the) Ticket's branch/i,
];

function files(dir: string): string[] {
  const path = join(ROOT, dir);
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    if (statSync(child).isDirectory()) return files(relative(ROOT, child));
    if (/\.test\.ts$/.test(name) || !/\.(ts|md|txt)$/.test(name)) return [];
    return [child];
  });
}

/** The text with its line breaks joined, comment markers and all, so a wrapped phrase still reads whole. */
function joined(text: string): string {
  return text.replace(/\s*\n\s*(?:\*(?!\/)|\/\/)?\s*/g, " ");
}

describe("what the pipeline ships", () => {
  const shipped = [...SHIPPED.flatMap(files), ...PAGES.map((page) => join(ROOT, page))];

  it("reads some files, so a moved directory cannot make it pass on nothing", () => {
    expect(shipped.some((file) => file.endsWith(join("src", "orchestrator.ts")))).toBe(true);
    expect(shipped.some((file) => file.endsWith(join("ports", "workspace.ts")))).toBe(true);
  });

  it.each(RETIRED.map((pattern) => [pattern.source, pattern] as const))(
    "says nowhere that a Check runs on a Ticket's branch: %s",
    (_source, pattern) => {
      const found = shipped.filter((file) => pattern.test(joined(readFileSync(file, "utf8"))));
      expect(found.map((file) => relative(ROOT, file))).toEqual([]);
    },
  );

  it("still catches a retired phrase a comment wraps across lines", () => {
    const comment = "/**\n * a base branch that fails the\n * Check the Ticket's branch failed\n */";
    expect(RETIRED.some((pattern) => pattern.test(joined(comment)))).toBe(true);
  });
});

/**
 * A Stage once had a cap on its turns beside its wall-clock limit, and the
 * progress comment counted them. Its only limit is its minutes now (ADR-0002's
 * amendment), so nothing shipped may still give a Stage's turns as a limit: not
 * a page, a template, a prompt, a code comment, an ADR's amendment, nor a test
 * name. The CHANGELOG and the ADRs' bodies above their amendments keep their
 * history. A turn as a unit of work, as in "spend your turns", is not covered.
 */
const RETIRED_TURN_LIMIT: readonly RegExp[] = [
  /maxTurns/,
  /--max-turns/,
  /turn-capped/,
  /turn capped/i,
  /turn limit/i,
  /out of turns/i,
  /턴 한도/,
  /턴이나 시간/,
  /턴이 바닥/,
  /\b\d+ turns?,? and \d+ minutes/i,
  /\d+ ?턴, ?\d+ ?분/,
];

/** Every ADR's amendments, without the body above the first of them. */
function amendments(): { file: string; text: string }[] {
  const dir = join(ROOT, "docs", "adr");
  return readdirSync(dir).flatMap((name) => {
    const text = readFileSync(join(dir, name), "utf8");
    const first = text.indexOf("\n## Amendment");
    return first === -1 ? [] : [{ file: join(dir, name), text: text.slice(first) }];
  });
}

/** Every test file under `src`, wherever it is. */
function testFiles(dir = "src"): string[] {
  const path = join(ROOT, dir);
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    if (statSync(child).isDirectory()) return testFiles(relative(ROOT, child));
    return name.endsWith(".test.ts") ? [child] : [];
  });
}

/** The names a test file gives its tests and their groups, `it.each` names included. */
function testNames(text: string): string[] {
  const opening = /(?:\b(?:it|describe|test)(?:\.\w+)?|[\])]\s*(?:as const)?\s*\))\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;
  return [...text.matchAll(opening)].map((match) => match[2] ?? "");
}

describe("what the pipeline ships, on a Stage's turns", () => {
  const shipped = [
    ...[...SHIPPED.flatMap(files), ...PAGES.map((page) => join(ROOT, page))].map((file) => ({
      file,
      text: joined(readFileSync(file, "utf8")),
    })),
    ...amendments().map(({ file, text }) => ({ file, text: joined(text) })),
    ...testFiles().map((file) => ({
      file,
      text: testNames(readFileSync(file, "utf8")).join("\n"),
    })),
  ];

  it("reads pages, amendments and test names, so a moved directory cannot make it pass on nothing", () => {
    expect(shipped.some(({ file }) => file.endsWith(join("wiki", "en", "guide", "configuration.md")))).toBe(true);
    expect(shipped.some(({ file }) => file.endsWith("0002-claude-p-child-process-per-stage.md"))).toBe(true);
    const names = shipped.find(({ file }) => file.endsWith("progress.test.ts"))?.text ?? "";
    expect(names).toContain("writes %i tokens as %s");
  });

  it.each(RETIRED_TURN_LIMIT.map((pattern, index) => [index, pattern] as const))(
    "gives a Stage's turns as a limit nowhere, by retired wording %i",
    (_index, pattern) => {
      const found = shipped.filter(({ text }) => pattern.test(text));
      expect(found.map(({ file }) => relative(ROOT, file))).toEqual([]);
    },
  );

  it("still reads a turn as a unit of work", () => {
    const prompt = "Do not run them to grade the branch: spend your turns on targeted tests.";
    expect(RETIRED_TURN_LIMIT.some((pattern) => pattern.test(prompt))).toBe(false);
  });

  it("reads the name an `it.each` gives its tests", () => {
    const text = 'it.each([\n  [1, "a"],\n] as const)("names case %i", () => {});';
    expect(testNames(text)).toEqual(["names case %i"]);
  });
});
