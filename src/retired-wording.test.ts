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
