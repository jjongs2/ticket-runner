import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_FILENAME, type Config } from "./config.js";
import {
  CLAUDE_SECTION,
  CONVENTIONS_PATH,
  conventionsDoc,
  conventionsMark,
} from "./conventions.js";
import { ensureLabels } from "./labels.js";
import {
  type AgentPreflight,
  type AgentRunner,
  SKILLS_PLUGIN,
} from "./ports/agent-runner.js";
import type { Authentication, Tracker } from "./ports/tracker.js";
import {
  CLAUDE_FILENAME,
  GH_INSTALL,
  GH_NOT_INSTALLED,
  hasClaudePointer,
  missingIgnoreLines,
  readTargetFile,
} from "./readiness.js";
import { OPERATOR_SKILL_PATH, operatorSkill } from "./operator-skill.js";
import { nestedRunRefusal } from "./stage-guard.js";
import { newerVersionLine } from "./staleness.js";
import { isHigher, versionNumber } from "./version-number.js";

/**
 * `agent-pipeline init`: put in place what a Run will expect to find in a
 * Target, and report on what only the human can put there.
 *
 * Three parts, in the order a reader of the report meets them: what was written
 * into the Target, what was done on GitHub, and what was only looked at. It
 * commits nothing and takes no Run lock, because it claims no Ticket, and
 * running it twice is running it once: every write asks first whether the
 * Target already has the thing.
 *
 * The files a human owns — `.gitignore`, `CLAUDE.md` — only ever gain lines.
 * The conventions document and the Operator's skill are the exception, and the
 * document says so in its own first paragraph: they are the pipeline's text, so
 * a Target carrying another copy is rewritten and told that it was. The
 * exception to the exception is a Target a newer pipeline set up, which the
 * mark on the document's first line is how this knows: rewriting either would
 * take the Target backwards, so both are left alone and the upgrade is named
 * instead (ADR-0007).
 *
 * The Target's own files are read and written here rather than through a port,
 * which every other external effect of the pipeline goes through. Setting a
 * Target up is not something a Run does, so no port of a Run describes it, and
 * a fourth port for five `writeFileSync` calls would be a port with one
 * implementation and one caller. What the ports buy elsewhere — a fake to
 * drive the state machine with — a temporary repository root buys here, which
 * is how the local state under `.agent-pipeline/` is already tested (ADR-0004).
 */

/** Where GitHub Actions keeps a Target's workflows. */
const WORKFLOWS_DIR = join(".github", "workflows");

const PASS = "✓";
const FAIL = "✗";

export interface InitOptions {
  repoRoot: string;
  /**
   * The Version doing the setting up, which the report's first line names. A
   * string the CLI resolved, never something read from here (ADR-0007).
   */
  version: string;
  /**
   * The pipeline's own repository, as `owner/name`, which the newer-Version
   * notice is looked up against; see {@link import("./staleness.js")}.
   */
  repository?: string | undefined;
  config: Config;
  tracker: Tracker;
  runner: AgentRunner;
  /**
   * The shell `init` was started in, which the Stage mark is read from.
   *
   * The CLI refuses a marked shell before it parses a single argument, so this
   * never fires in production. It is here because `init` is the one command
   * that writes into the Target, and the CLI is deliberately untested: this is
   * the seam the refusal is proved through.
   */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/**
 * Set the Target up and report on it. Returns the exit code: 2 when a Stage's
 * shell was refused, 1 when any reported item failed, 0 when none did.
 */
export async function initTarget(options: InitOptions): Promise<number> {
  const { repoRoot, version, config, tracker, runner } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));

  // Before the first read and the first write of the Target.
  const nested = nestedRunRefusal(options.env ?? process.env);
  if (nested !== undefined) {
    error(nested);
    return 2;
  }

  log(`agent-pipeline ${version} init · ${repoRoot}`);

  // The first thing after the opening line, so a human setting a Target up with
  // an old copy reads it before the report it is about to change their mind
  // about. Never a refusal: `init` sets the Target up either way.
  const newer = await newerVersionLine({
    tracker,
    version,
    repository: options.repository,
  });
  if (newer !== undefined) log(newer);

  const written = writeTargetFiles(repoRoot, version);

  // Asked before the labels, because every other GitHub call throws without it
  // and a report is more use to the human than a stack trace.
  const authentication = await tracker.authentication();
  const preflight = await runner.preflight();
  const github = await updateGitHub(tracker, config, authentication);
  const reported = reportedItems(repoRoot, config, authentication, preflight);

  logGroup(log, "Wrote", written, "nothing to write");
  logGroup(log, "GitHub", github);
  logGroup(
    log,
    "Checked",
    reported.map((item) => `${item.ok ? PASS : FAIL} ${item.line}`),
  );

  const failed = reported.filter((item) => !item.ok).length;
  log("");
  log(
    failed === 0
      ? "Ready: everything a Run expects of this Target is in place."
      : `Not ready: ${failed} ${failed === 1 ? "item is" : "items are"} yours to put right.`,
  );
  return failed === 0 ? 0 : 1;
}

/** One headed group of the report, indented under its heading. */
function logGroup(
  log: (line: string) => void,
  heading: string,
  lines: string[],
  empty = "nothing to do",
): void {
  log("");
  log(`${heading}:`);
  for (const line of lines.length === 0 ? [empty] : lines) log(`  ${line}`);
}

/** What the Target gained on disk, one line per file that changed. */
function writeTargetFiles(repoRoot: string, version: string): string[] {
  // Read once, before the document it is read from is rewritten: it decides
  // whether the skill is too.
  const newer = newerSetUp(repoRoot, version);
  return [
    ensureGitignore(repoRoot),
    ensureConfigFile(repoRoot),
    ensureConventionsDoc(repoRoot, version, newer),
    ensureClaudePointer(repoRoot),
    ensureOperatorSkill(repoRoot, newer),
  ].filter((line): line is string => line !== undefined);
}

/**
 * The Version that set this Target up, where it is newer than the one setting
 * it up now, and nothing otherwise.
 *
 * Read off the conventions document's mark, which is the only thing in a
 * Target that says which pipeline wrote it, so it answers for the skill too.
 */
function newerSetUp(repoRoot: string, version: string): NewerSetUp | undefined {
  const mark = conventionsMark(readTargetFile(join(repoRoot, CONVENTIONS_PATH)));
  const own = versionNumber(version);
  return mark !== undefined && own !== undefined && isHigher(mark, own)
    ? { mark, own }
    : undefined;
}

/** Which newer Version set a Target up, and which one found it. */
interface NewerSetUp {
  mark: string;
  own: string;
}

/** The line for a file of the pipeline's own that a newer pipeline wrote. */
function leftAlone(path: string, { mark, own }: NewerSetUp): string {
  return `${path}: left alone, because ${mark} set this Target up and this is ${own} — upgrade \`agent-pipeline\` to rewrite it`;
}

/**
 * Add whichever of the pipeline's two directories the Target does not already
 * ignore, so a Target that ignores one of them under a comment of its own keeps
 * its comment and gains nothing.
 */
function ensureGitignore(repoRoot: string): string | undefined {
  const missing = missingIgnoreLines(repoRoot);
  if (missing.length === 0) return undefined;

  const path = join(repoRoot, ".gitignore");
  const existing = readTargetFile(path) ?? "";
  const additions = missing.map((entry) => `${entry.comment}\n${entry.line}\n`).join("\n");
  writeFileSync(path, `${existing}${separator(existing)}${additions}`);
  return `.gitignore: added ${missing.map((entry) => `\`${entry.line}\``).join(" and ")}`;
}

/**
 * An empty config file, so the Target has the obvious place to put a setting.
 * Never read: whatever a Target's file says, it is the Target's.
 */
function ensureConfigFile(repoRoot: string): string | undefined {
  const path = join(repoRoot, CONFIG_FILENAME);
  if (existsSync(path)) return undefined;
  writeFileSync(path, "{}\n");
  return `${CONFIG_FILENAME}: created, with every setting left at its default`;
}

/**
 * The pipeline's own text, so a Target never carries an older copy of it —
 * unless the copy here is a newer pipeline's, which is the one case where
 * rewriting would take the Target backwards.
 *
 * The mark is read before the text, because it is the only thing that says
 * which way round the two copies are. Nothing is refused either way: a Target
 * is not worse for carrying a document from another Version.
 */
function ensureConventionsDoc(
  repoRoot: string,
  version: string,
  newer: NewerSetUp | undefined,
): string | undefined {
  if (newer !== undefined) return leftAlone(CONVENTIONS_PATH, newer);

  const path = join(repoRoot, CONVENTIONS_PATH);
  const existing = readTargetFile(path);
  const mark = conventionsMark(existing);
  const own = versionNumber(version);

  const doc = conventionsDoc(version);
  if (existing === doc) return undefined;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, doc);
  return `${CONVENTIONS_PATH}: ${rewritten(existing, mark, own)}`;
}

/**
 * Which of the four ways a copy came to be rewritten this one was.
 *
 * A copy marked with this very Version is the odd one: nothing about the
 * pipeline moved, so the difference is something the Target did to the file,
 * and saying it was left by the Version now writing it would read as nonsense.
 */
function rewritten(
  existing: string | undefined,
  mark: string | undefined,
  own: string | undefined,
): string {
  if (existing === undefined) return "written";
  if (mark === undefined) return "overwritten, because the copy here carried no Version";
  if (mark === own) return "overwritten, because the copy here said something else";
  return `overwritten, because the copy here was left by ${mark}`;
}

/**
 * Point the Target's `CLAUDE.md` at the conventions document, where a Run would
 * find no pointer. A second copy of the section would only be noise in the file
 * every session reads.
 */
function ensureClaudePointer(repoRoot: string): string | undefined {
  const path = join(repoRoot, CLAUDE_FILENAME);
  const existing = readTargetFile(path);
  if (hasClaudePointer(existing)) return undefined;

  const before = existing ?? "";
  writeFileSync(path, `${before}${separator(before)}${CLAUDE_SECTION}`);
  return existing === undefined
    ? `${CLAUDE_FILENAME}: created, pointing at ${CONVENTIONS_PATH}`
    : `${CLAUDE_FILENAME}: added the section pointing at ${CONVENTIONS_PATH}`;
}

/**
 * The Operator's instructions, which a cloud session finds nowhere but in the
 * Target (ADR-0008).
 *
 * The pipeline's own text, rewritten when it says something else, like the
 * conventions document. It carries no mark of its own, so a Target a newer
 * pipeline set up is known by the document's, and keeps what that pipeline
 * wrote. One it left without a skill still gets this one: an older skill is
 * something an Operator can follow, and no skill is a Target every Run refuses.
 */
function ensureOperatorSkill(repoRoot: string, newer: NewerSetUp | undefined): string | undefined {
  const path = join(repoRoot, OPERATOR_SKILL_PATH);
  const existing = readTargetFile(path);
  if (existing !== undefined && newer !== undefined) return leftAlone(OPERATOR_SKILL_PATH, newer);

  const skill = operatorSkill();
  if (existing === skill) return undefined;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, skill);
  return existing === undefined
    ? `${OPERATOR_SKILL_PATH}: written`
    : `${OPERATOR_SKILL_PATH}: overwritten, because the copy here said something else`;
}

/**
 * What goes between what a file already says and what it is gaining: a blank
 * line, and the newline the file's own last line may be missing.
 */
function separator(existing: string): string {
  if (existing === "") return "";
  return existing.endsWith("\n") ? "\n" : "\n\n";
}

/**
 * What is wrong with a `gh` that cannot speak to GitHub, as both groups say it,
 * and what the human does about it: only a `gh` that runs can be logged in.
 */
const GH_FAILURE: Record<
  Exclude<Authentication, "authenticated">,
  { failure: string; remedy: string }
> = {
  unauthenticated: { failure: "`gh` is not authenticated", remedy: "run `gh auth login`" },
  "not-installed": { failure: GH_NOT_INSTALLED, remedy: GH_INSTALL },
};

/** The three things `init` does on GitHub, and the one thing that stops them all. */
async function updateGitHub(
  tracker: Tracker,
  config: Config,
  authentication: Authentication,
): Promise<string[]> {
  if (authentication !== "authenticated") return [`nothing done: ${GH_FAILURE[authentication].failure}`];

  const created = await ensureLabels(tracker, config.labels);
  // Asked for every time: the setting is the Target's to have on, and GitHub
  // reports no difference between turning it on and finding it on.
  await tracker.enableSquashMerge();
  // Read first, because readiness reads it too: a report that says which of
  // the two it found is one a human can match against a refusal.
  const deletesBranches = await tracker.deletesBranchOnMerge();
  if (!deletesBranches) await tracker.enableDeleteBranchOnMerge();
  return [
    created.length === 0
      ? "labels: every triage label is already there"
      : `labels: created ${created.join(", ")}`,
    "merges: squash merging is on, and no other merge method was touched",
    deletesBranches
      ? "branches: a pull request's branch is already deleted when it merges"
      : "branches: switched on deleting a pull request's branch when it merges",
  ];
}

/** One item `init` can only report on, and whether it passed. */
interface Reported {
  ok: boolean;
  line: string;
}

/**
 * What `init` cannot put in place itself: a login, two installs, a workflow the
 * Target's own CI owns, and a Check that has to be the human's to name.
 */
function reportedItems(
  repoRoot: string,
  config: Config,
  authentication: Authentication,
  preflight: AgentPreflight,
): Reported[] {
  return [
    ghReported(authentication),
    report(preflight.runs, "`claude` runs", "`claude` could not be run — install the Claude Code CLI"),
    report(
      preflight.plugin,
      `the \`${SKILLS_PLUGIN}\` plugin is installed`,
      `the \`${SKILLS_PLUGIN}\` plugin is not installed — an implement Stage has no skill without it`,
    ),
    report(
      hasCiWorkflow(repoRoot),
      `a CI workflow is present in \`${WORKFLOWS_DIR}\``,
      `no CI workflow in \`${WORKFLOWS_DIR}\` — a pull request with no checks is never merged`,
    ),
    report(
      config.checks.length > 0,
      `a Check is configured or inferable: ${config.checks.join(", ")}`,
      `no Check is configured or inferable — name one in \`checks\` in ${CONFIG_FILENAME}, or add \`test\` and \`typecheck\` scripts to package.json`,
    ),
  ];
}

/** The `gh` item, which fails two ways and names the fix for each. */
function ghReported(authentication: Authentication): Reported {
  if (authentication === "authenticated") return { ok: true, line: "`gh` is authenticated" };
  const { failure, remedy } = GH_FAILURE[authentication];
  return { ok: false, line: `${failure} — ${remedy}` };
}

function report(ok: boolean, passed: string, failed: string): Reported {
  return { ok, line: ok ? passed : failed };
}

/** Any workflow file at all; what it runs is the Target's business. */
function hasCiWorkflow(repoRoot: string): boolean {
  try {
    return readdirSync(join(repoRoot, WORKFLOWS_DIR)).some((entry) => /\.ya?ml$/i.test(entry));
  } catch {
    return false;
  }
}
