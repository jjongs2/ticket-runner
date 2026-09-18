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
 *
 * The Target's own files are read here rather than through a port, which every
 * external effect of a Run goes through. What a port buys is a fake to drive the
 * state machine with, and there is no state machine here: this is four questions
 * asked of a directory before a Run exists, and the answers are already driven
 * from a temporary repository root, which is how the local state under
 * `.agent-pipeline/` is tested too (ADR-0004). Widening the `Workspace` port for
 * them would put reads no Stage and no Ticket ever makes on the interface the
 * orchestrator depends on.
 */

/** The file every agent session in a Target reads first. */
export const CLAUDE_FILENAME = "CLAUDE.md";

/** One of the pipeline's own directories, and the comment it is ignored under. */
export interface IgnoredDirectory {
  comment: string;
  line: string;
}

const IGNORED: readonly IgnoredDirectory[] = [
  { comment: "# Pipeline worktrees, one per Ticket.", line: ".worktrees/" },
  { comment: "# Run logs, transcripts and state.", line: ".agent-pipeline/" },
];

/**
 * Which of the pipeline's directories this Target's gitignore does not cover
 * yet, in the order they are written. Empty is a Target that ignores both.
 */
export function missingIgnoreLines(repoRoot: string): IgnoredDirectory[] {
  const ignored = new Set(
    (readTargetFile(join(repoRoot, ".gitignore")) ?? "").split("\n").map(ignorePattern),
  );
  return IGNORED.filter((entry) => !ignored.has(ignorePattern(entry.line)));
}

/**
 * What a gitignore line means, whatever it was punctuated as: `.worktrees`,
 * `.worktrees/` and `/.worktrees/` all keep the same directory out of a commit,
 * and a Target that already says one of them is not missing the others.
 */
function ignorePattern(line: string): string {
  return line.trim().replace(/^\//, "").replace(/\/$/, "");
}

/**
 * Whether a `CLAUDE.md` points at the conventions document, taking the contents
 * a Target has there and `undefined` for a Target with no such file.
 *
 * Judged on the path, not on the section `init` writes: a human who reworded the
 * section around the same path still has a pointer.
 */
export function hasClaudePointer(claude: string | undefined): boolean {
  return claude !== undefined && claude.includes(CONVENTIONS_PATH);
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
  const missing =
    missingFileMessage(repoRoot) ?? (await missingLabelMessage(tracker, labels));
  if (missing === undefined) return undefined;

  return [
    `This Target is not set up: ${missing}.`,
    "Run `agent-pipeline init` here and start again;",
    "a Run puts nothing in place itself.",
  ].join(" ");
}

/** Names the first thing `init` writes into a Target that this one does not have. */
function missingFileMessage(repoRoot: string): string | undefined {
  const [unignored] = missingIgnoreLines(repoRoot);
  if (unignored !== undefined) {
    return `\`.gitignore\` does not ignore \`${unignored.line}\``;
  }

  if (!existsSync(join(repoRoot, CONVENTIONS_PATH))) {
    return `\`${CONVENTIONS_PATH}\` is not there`;
  }

  if (!hasClaudePointer(readTargetFile(join(repoRoot, CLAUDE_FILENAME)))) {
    return `\`${CLAUDE_FILENAME}\` does not point at \`${CONVENTIONS_PATH}\``;
  }

  return undefined;
}

/** Names the first triage label this Target is missing, as config spells it. */
async function missingLabelMessage(
  tracker: Tracker,
  labels: Labels,
): Promise<string | undefined> {
  const existing = new Set(await tracker.listLabels());
  const missing = Object.values(labels).find((name) => !existing.has(name));
  return missing === undefined ? undefined : `the \`${missing}\` label is not on this Target`;
}

/** A Target file's contents, or nothing when the Target does not have it. */
export function readTargetFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
