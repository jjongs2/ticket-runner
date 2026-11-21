import { parse } from "yaml";

/**
 * Whether any of a Target's workflows can run on a pull request, read off the
 * workflow files as the pull request's branch has them.
 *
 * Asked before the wait for CI, so a pull request no workflow can run on gets
 * its answer at the first reading instead of after the whole grace a slow
 * Actions queue is given. Being wrong one way costs that grace; being wrong
 * the other merges a pull request before its CI registers. So a workflow is
 * ruled out only when the reader is certain, and anything it cannot read, or
 * cannot read for sure, counts as one that can run.
 */

/** Where GitHub looks for workflows: this directory, and not below it. */
export const WORKFLOWS_DIR = ".github/workflows";

/** One workflow file, by its path in the repository. */
export interface WorkflowFile {
  path: string;
  contents: string;
}

/** What GitHub filters a pull request's workflows on. */
export interface PullRequestPush {
  /** The branch the pull request merges into, which `pull_request` branch filters match. */
  base: string;
  /** The pull request's own branch, whose push `push` branch filters match. */
  head: string;
  /**
   * The files the pull request changes, a renamed file under both its old and
   * its new path, which `pull_request` path filters match.
   */
  changed: string[];
}

/**
 * The events that never run on a pull request's push: on a clock, by hand, from
 * the API, or from another workflow. Every other event counts as one that can.
 */
const NEVER_ON_A_PUSH = new Set(["schedule", "workflow_dispatch", "repository_dispatch", "workflow_call"]);

/** Whether a workflow file names a workflow file GitHub would read: YAML, in the directory itself. */
export function isWorkflowPath(path: string): boolean {
  const name = path.slice(WORKFLOWS_DIR.length + 1);
  return path.startsWith(`${WORKFLOWS_DIR}/`) && !name.includes("/") && /\.ya?ml$/i.test(name);
}

/** Whether any of `files` can run on the pull request; none at all is none that can. */
export function anyWorkflowCanRun(files: WorkflowFile[], pr: PullRequestPush): boolean {
  return files.some((file) => workflowCanRun(file.contents, pr));
}

/**
 * Whether one workflow can run on the pull request: yes when any of its events
 * can, and when the file cannot be read for sure.
 */
export function workflowCanRun(contents: string, pr: PullRequestPush): boolean {
  let workflow: unknown;
  try {
    workflow = parse(contents);
  } catch {
    return true;
  }
  if (!isRecord(workflow)) return true;
  const events = eventsOf(workflow["on"]);
  if (events === undefined || events.length === 0) return true;
  return events.some(([event, filters]) => eventCanRun(event, filters, pr));
}

/** The workflow's events with whatever each filters on, in the three shapes `on` takes. */
function eventsOf(on: unknown): [string, unknown][] | undefined {
  if (typeof on === "string") return [[on, null]];
  if (Array.isArray(on)) {
    return on.every((event) => typeof event === "string")
      ? on.map((event: string) => [event, null])
      : undefined;
  }
  return isRecord(on) ? Object.entries(on) : undefined;
}

/**
 * Whether one event can run on the pull request. GitHub runs an event only
 * when every filter on it holds, so one evaluated filter that excludes the pull
 * request rules the event out, whatever else it filters on; a filter not
 * evaluated here, such as `types` or `tags`, only ever narrows it further.
 */
function eventCanRun(event: string, filters: unknown, pr: PullRequestPush): boolean {
  if (NEVER_ON_A_PUSH.has(event)) return false;
  if (event !== "pull_request" && event !== "push") return true;
  if (filters === null || filters === undefined) return true;
  if (!isRecord(filters)) return true;

  if (event === "push") {
    return !(
      excludes("include", filters["branches"], [pr.head]) ||
      excludes("ignore", filters["branches-ignore"], [pr.head])
    );
  }
  return !(
    excludes("include", filters["branches"], [pr.base]) ||
    excludes("ignore", filters["branches-ignore"], [pr.base]) ||
    excludes("include", filters["paths"], pr.changed) ||
    excludes("ignore", filters["paths-ignore"], pr.changed)
  );
}

/**
 * Whether a filter certainly excludes the pull request: an including filter
 * when no subject matches any pattern, an ignoring one when every subject
 * matches one. A filter that is absent, has a pattern this cannot read, or
 * has nothing to match excludes nothing.
 */
function excludes(kind: "include" | "ignore", values: unknown, subjects: string[]): boolean {
  if (values === undefined || subjects.length === 0) return false;
  const patterns = compileAll(values);
  if (patterns === undefined) return false;
  return subjects.every((subject) =>
    kind === "include"
      ? patterns.every((matches) => matches(subject) === "no")
      : patterns.some((matches) => matches(subject) === "yes"),
  );
}

/** Whether a pattern matches, or `unknown` where the answer turns on how GitHub treats a leading dot. */
type Match = "yes" | "no" | "unknown";

/** A filter's patterns, or nothing when any one of them is one this does not read. */
function compileAll(values: unknown): ((subject: string) => Match)[] | undefined {
  const list = typeof values === "string" ? [values] : values;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const patterns: ((subject: string) => Match)[] = [];
  for (const value of list) {
    const pattern = compile(value);
    if (pattern === undefined) return undefined;
    patterns.push(pattern);
  }
  return patterns;
}

/**
 * The characters that make a pattern one this does not read: GitHub's `?`,
 * `+`, `[]` and escapes, and the braces and parentheses a glob library would
 * read as alternatives, where reading them as literals could rule out a
 * workflow that runs.
 */
const UNREAD = /[?+[\]\\{}()|]/;

/**
 * One pattern as GitHub's filter pattern cheat sheet reads it: `*` is any run
 * of characters but `/`, `**` any run at all, and `**` before a `/` any run
 * of whole directories, none included. Nothing for a pattern this does not read.
 *
 * Whether a wildcard matches a name that starts with `.` is left open, so a
 * match that needs one to is `unknown`: it is matched twice, once letting
 * wildcards cross such a name and once not, and only the two agreeing is an
 * answer.
 */
function compile(value: unknown): ((subject: string) => Match) | undefined {
  if (typeof value !== "string" || value === "" || value.startsWith("!") || UNREAD.test(value)) {
    return undefined;
  }
  const loose = regex(value, { any: ".", segment: "[^/]" });
  // A dot a wildcard takes must follow something on its own name: not the
  // start of the subject, and not a `/`.
  const strict = regex(value, {
    any: "(?:[^.]|(?<=[^/])\\.)",
    segment: "(?:[^/.]|(?<=[^/])\\.)",
  });
  return (subject) => (strict.test(subject) ? "yes" : loose.test(subject) ? "unknown" : "no");
}

function regex(pattern: string, wildcard: { any: string; segment: string }): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("**/", i)) {
      source += `(?:${wildcard.any}*/)?`;
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      source += `${wildcard.any}*`;
      i += 2;
    } else if (pattern[i] === "*") {
      source += `${wildcard.segment}*`;
      i += 1;
    } else {
      source += (pattern[i] as string).replace(/[.^$|?*+()[\]{}\\/]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${source}$`, "s");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
