import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Labels } from "./config.js";
import { CONVENTIONS_PATH } from "./conventions.js";
import type { Tracker } from "./ports/tracker.js";

/**
 * What `agent-pipeline init` must have left in a Target before a Run may start.
 *
 * One module says what a set-up Target looks like and two commands read it:
 * `init` puts each item in place, and `run` and `ticket` refuse a Target that is
 * missing one. A Run repairs nothing — a command that quietly wrote into the
 * Target it was only asked to work in is the thing `init` exists to keep to one
 * place — so the refusal names the item and the command that fixes it.
 *
 * Presence only, never content. The conventions document is the pipeline's own
 * text and changes with it, so comparing it at every start would refuse a Target
 * for carrying last week's copy, which is a thing the next `init` rewrites and
 * nothing a Run is worse for.
 */

/** The file every agent session in a Target reads first. */
export const CLAUDE_FILENAME = "CLAUDE.md";

/** The pipeline's own directories, with the comment each is ignored under. */
export const IGNORED = [
  { comment: "# Pipeline worktrees, one per Ticket.", line: ".worktrees/" },
  { comment: "# Run logs, transcripts and state.", line: ".agent-pipeline/" },
] as const;

/**
 * What a gitignore line means, whatever it was punctuated as: `.worktrees`,
 * `.worktrees/` and `/.worktrees/` all keep the same directory out of a commit,
 * and a Target that already says one of them is not missing the others.
 */
export function ignorePattern(line: string): string {
  return line.trim().replace(/^\//, "").replace(/\/$/, "");
}

export interface ReadinessOptions {
  repoRoot: string;
  labels: Labels;
  tracker: Tracker;
}

/**
 * The message a Run is refused with when this Target is not set up, and nothing
 * when it is.
 *
 * The first missing item is the whole message: a human who has not run `init`
 * here is missing all of them, and one item to put right reads as one command to
 * type. The Target's own files are asked about before GitHub is, so that Target
 * is refused without a network call at all.
 */
export async function readinessRefusal({
  repoRoot,
  labels,
  tracker,
}: ReadinessOptions): Promise<string | undefined> {
  const missing = missingFile(repoRoot) ?? (await missingLabel(tracker, labels));
  if (missing === undefined) return undefined;

  return [
    `This Target is not set up: ${missing}.`,
    "Run `agent-pipeline init` here and start again;",
    "a Run puts nothing in place itself.",
  ].join(" ");
}

/** The first of the four files `init` writes that this Target does not have. */
function missingFile(repoRoot: string): string | undefined {
  const ignored = new Set(
    (read(join(repoRoot, ".gitignore")) ?? "").split("\n").map(ignorePattern),
  );
  const unignored = IGNORED.find((entry) => !ignored.has(ignorePattern(entry.line)));
  if (unignored !== undefined) {
    return `\`.gitignore\` does not ignore \`${unignored.line}\``;
  }

  if (!existsSync(join(repoRoot, CONVENTIONS_PATH))) {
    return `\`${CONVENTIONS_PATH}\` is not there`;
  }

  const claude = read(join(repoRoot, CLAUDE_FILENAME));
  if (claude === undefined || !claude.includes(CONVENTIONS_PATH)) {
    return `\`${CLAUDE_FILENAME}\` does not point at \`${CONVENTIONS_PATH}\``;
  }

  return undefined;
}

/** The first triage label this Target is missing, under the name config gives it. */
async function missingLabel(tracker: Tracker, labels: Labels): Promise<string | undefined> {
  const existing = new Set(await tracker.listLabels());
  const missing = Object.values(labels).find((name) => !existing.has(name));
  return missing === undefined ? undefined : `the \`${missing}\` label is not on this Target`;
}

/** A file's contents, or nothing when the Target does not have it. */
function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
