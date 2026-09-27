import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Labels } from "./config.js";
import { CLAUDE_SECTION, CONVENTIONS_PATH, conventionsMark } from "./conventions.js";
import { OPERATOR_SKILL_PATH } from "./operator-skill.js";
import type { Authentication, Tracker } from "./ports/tracker.js";

/**
 * What `ticket-runner init` must have left in a Target before a Run may start.
 *
 * One module says what a set-up Target looks like and two commands read it:
 * `init` puts each item in place, and `run` and `ticket` refuse a Target that is
 * missing one. A Run repairs nothing — a command that quietly wrote into the
 * Target it was only asked to work in is the thing `init` exists to keep to one
 * place — so the refusal names the item and the command that fixes it.
 *
 * Presence and the Version stamp, never content. The conventions document and
 * the Operator's skill are the pipeline's own text and change with it, so
 * comparing either at every start would refuse a Target for carrying last
 * week's copy, which is a thing the next `init` rewrites and nothing a Run is
 * worse for. The document's Version stamp is asked for, though never which
 * Version it names: an Operator installs the pipeline a cloud Host runs at that
 * Version, and a Target without one leaves it guessing (ADR-0008).
 *
 * The Target's own files are read here rather than through a port, which every
 * external effect of a Run goes through. What a port buys is a fake to drive the
 * state machine with, and there is no state machine here: this is five questions
 * asked of a directory before a Run exists, and the answers are already driven
 * from a temporary repository root, which is how the local state under
 * `.ticket-runner/` is tested too (ADR-0004). Widening the `Workspace` port for
 * them would put reads no Stage and no Ticket ever makes on the interface the
 * orchestrator depends on.
 *
 * Every item is asked on every Host, the cloud's own needs included, so a
 * Target a workstation accepts is never one a cloud Run then refuses.
 */

/** The file every agent session in a Target reads first. */
export const CLAUDE_FILENAME = "CLAUDE.md";

/** One of the pipeline's own directories, and the comment it is ignored under. */
export interface IgnoredDirectory {
  comment: string;
  line: string;
}

/**
 * The pipeline's two directories, each under the comment `init` writes it
 * with, in the order it writes them. `remove` takes an entry out only where
 * both lines still read exactly this, so the two commands share one text.
 */
export const IGNORED: readonly IgnoredDirectory[] = [
  { comment: "# Pipeline worktrees, one per Ticket.", line: ".worktrees/" },
  { comment: "# Run logs, transcripts and state.", line: ".ticket-runner/" },
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
 * A gitignore without `entry`, where `init`'s comment and line are still there
 * exactly and one straight after the other, and nothing where they are not:
 * a line the Target ignores under a comment of its own may be the Target's.
 *
 * The blank line `init` put between the entry and what came before goes with
 * it, so a gitignore reads as it did before `init` wrote into it.
 */
export function withoutIgnoreEntry(
  gitignore: string,
  entry: IgnoredDirectory,
): string | undefined {
  const lines = gitignore.split("\n");
  // The empty string after a last newline is no line of the file.
  const ended = lines.at(-1) === "";
  if (ended) lines.pop();

  const at = lines.findIndex(
    (line, index) => line === entry.comment && lines[index + 1] === entry.line,
  );
  if (at === -1) return undefined;
  lines.splice(at, 2);
  if (lines[at] === "" && (at === 0 || lines[at - 1] === "")) lines.splice(at, 1);
  else if (at === lines.length && lines[at - 1] === "") lines.splice(at - 1, 1);

  return lines.length === 0 ? "" : `${lines.join("\n")}${ended ? "\n" : ""}`;
}

/**
 * A `CLAUDE.md` without the section `init` appends, where it is still there
 * exactly and starts a line, and nothing where it is not: a section a human
 * reworded is theirs, pointer or not. The blank line before it goes too.
 */
export function withoutClaudeSection(claude: string): string | undefined {
  let at = claude.indexOf(CLAUDE_SECTION);
  while (at > 0 && claude[at - 1] !== "\n") at = claude.indexOf(CLAUDE_SECTION, at + 1);
  if (at === -1) return undefined;

  let before = claude.slice(0, at);
  let after = claude.slice(at + CLAUDE_SECTION.length);
  if (after === "" || after.startsWith("\n")) {
    if (before.endsWith("\n\n")) before = before.slice(0, -1);
    else if (before === "") after = after.slice(1);
  }
  return `${before}${after}`;
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
 * is refused without a network call at all. Whether `gh` is there to ask comes
 * next, so a Host without it is refused in words rather than with the spawn
 * error the first label lookup would crash on.
 */
export async function readinessRefusal({
  repoRoot,
  labels,
  tracker,
}: ReadinessOptions): Promise<string | undefined> {
  const missing =
    missingFileMessage(repoRoot) ??
    (await missingGhMessage(tracker)) ??
    (await missingLabelMessage(tracker, labels)) ??
    (await missingBranchDeletionMessage(tracker));
  if (missing === undefined) return undefined;

  return [
    `This Target is not set up: ${missing}.`,
    "Run `ticket-runner init` here and start again;",
    "a Run puts nothing in place itself.",
  ].join(" ");
}

/** Names the first thing `init` writes into a Target that this one does not have. */
function missingFileMessage(repoRoot: string): string | undefined {
  const [unignored] = missingIgnoreLines(repoRoot);
  if (unignored !== undefined) {
    return `\`.gitignore\` does not ignore \`${unignored.line}\``;
  }

  const conventions = readTargetFile(join(repoRoot, CONVENTIONS_PATH));
  if (conventions === undefined) {
    return `\`${CONVENTIONS_PATH}\` is not there`;
  }
  if (conventionsMark(conventions) === undefined) {
    return `\`${CONVENTIONS_PATH}\` carries no Version`;
  }

  if (!hasClaudePointer(readTargetFile(join(repoRoot, CLAUDE_FILENAME)))) {
    return `\`${CLAUDE_FILENAME}\` does not point at \`${CONVENTIONS_PATH}\``;
  }

  // Asked of a workstation too, though only a cloud session reads it: a Target
  // a local Run accepts is then one the app can run as well (ADR-0008).
  if (readTargetFile(join(repoRoot, OPERATOR_SKILL_PATH)) === undefined) {
    return `the Operator's skill \`${OPERATOR_SKILL_PATH}\` is not there`;
  }

  return undefined;
}

/** What `init` and readiness both call a Host with no `gh` it can run. */
export const GH_NOT_INSTALLED = "`gh` is not installed";

/** What the human does about it, which neither of them can do for them. */
export const GH_INSTALL = "install the GitHub CLI from https://cli.github.com";

/**
 * What is wrong with a `gh` that cannot speak to GitHub, as `init` and `remove`
 * both say it, and what the human does about it: only a `gh` that runs can be
 * logged in.
 */
export const GH_FAILURE: Record<
  Exclude<Authentication, "authenticated">,
  { failure: string; remedy: string }
> = {
  unauthenticated: { failure: "`gh` is not authenticated", remedy: "run `gh auth login`" },
  "not-installed": { failure: GH_NOT_INSTALLED, remedy: GH_INSTALL },
};

/**
 * Names a `gh` that cannot be run at all, and the install that comes before
 * the `init` the refusal goes on to name. One that runs but is not logged in is
 * left to the GitHub questions after it, which fail on it loudly enough.
 */
async function missingGhMessage(tracker: Tracker): Promise<string | undefined> {
  return (await tracker.authentication()) === "not-installed"
    ? `${GH_NOT_INSTALLED} — ${GH_INSTALL} first`
    : undefined;
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

/**
 * Names the repository setting a cloud Host depends on, when it is off: nothing
 * there can delete a branch, so a merged Ticket's goes only if GitHub takes it.
 */
async function missingBranchDeletionMessage(tracker: Tracker): Promise<string | undefined> {
  return (await tracker.deletesBranchOnMerge())
    ? undefined
    : "the repository does not delete a pull request's branch when it merges";
}

/** A Target file's contents, or nothing when the Target does not have it. */
export function readTargetFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
