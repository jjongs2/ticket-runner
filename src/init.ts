import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_FILENAME, type Config } from "./config.js";
import { CLAUDE_SECTION, CONVENTIONS_DOC, CONVENTIONS_PATH } from "./conventions.js";
import { ensureLabels } from "./labels.js";
import {
  type AgentPreflight,
  type AgentRunner,
  SKILLS_PLUGIN,
} from "./ports/agent-runner.js";
import type { Tracker } from "./ports/tracker.js";
import {
  CLAUDE_FILENAME,
  hasClaudePointer,
  missingIgnoreLines,
  readTargetFile,
} from "./readiness.js";
import { nestedRunRefusal } from "./stage-guard.js";

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
 * The conventions document is the one exception, and it says so in its own
 * first paragraph: it is the pipeline's text, so a Target carrying an older
 * copy is rewritten and told that it was.
 *
 * The Target's own files are read and written here rather than through a port,
 * which every other external effect of the pipeline goes through. Setting a
 * Target up is not something a Run does, so no port of a Run describes it, and
 * a fourth port for four `writeFileSync` calls would be a port with one
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
  const { repoRoot, config, tracker, runner } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));

  // Before the first read and the first write of the Target.
  const nested = nestedRunRefusal(options.env ?? process.env);
  if (nested !== undefined) {
    error(nested);
    return 2;
  }

  log(`agent-pipeline init · ${repoRoot}`);

  const written = writeTargetFiles(repoRoot);

  // Asked before the labels, because every other GitHub call throws without it
  // and a report is more use to the human than a stack trace.
  const authenticated = await tracker.authenticated();
  const preflight = await runner.preflight();
  const github = await updateGitHub(tracker, config, authenticated);
  const reported = reportedItems(repoRoot, config, authenticated, preflight);

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
function writeTargetFiles(repoRoot: string): string[] {
  return [
    ensureGitignore(repoRoot),
    ensureConfigFile(repoRoot),
    ensureConventionsDoc(repoRoot),
    ensureClaudePointer(repoRoot),
  ].filter((line): line is string => line !== undefined);
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

/** The pipeline's own text, so a Target never carries an older copy of it. */
function ensureConventionsDoc(repoRoot: string): string | undefined {
  const path = join(repoRoot, CONVENTIONS_PATH);
  const existing = readTargetFile(path);
  if (existing === CONVENTIONS_DOC) return undefined;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, CONVENTIONS_DOC);
  return existing === undefined
    ? `${CONVENTIONS_PATH}: written`
    : `${CONVENTIONS_PATH}: overwritten, because the copy here said something else`;
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
 * What goes between what a file already says and what it is gaining: a blank
 * line, and the newline the file's own last line may be missing.
 */
function separator(existing: string): string {
  if (existing === "") return "";
  return existing.endsWith("\n") ? "\n" : "\n\n";
}

/** The two things `init` does on GitHub, and the one thing that stops both. */
async function updateGitHub(
  tracker: Tracker,
  config: Config,
  authenticated: boolean,
): Promise<string[]> {
  if (!authenticated) return ["nothing done: `gh` is not authenticated"];

  const created = await ensureLabels(tracker, config.labels);
  // Asked for every time: the setting is the Target's to have on, and GitHub
  // reports no difference between turning it on and finding it on.
  await tracker.enableSquashMerge();
  return [
    created.length === 0
      ? "labels: every triage label is already there"
      : `labels: created ${created.join(", ")}`,
    "merges: squash merging is on, and no other merge setting was touched",
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
  authenticated: boolean,
  preflight: AgentPreflight,
): Reported[] {
  return [
    report(authenticated, "`gh` is authenticated", "`gh` is not authenticated — run `gh auth login`"),
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
