import { existsSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { AGENT_BRANCH_PREFIX } from "./branch.js";
import { CONFIG_FILENAME, type Config } from "./config.js";
import { CONVENTIONS_PATH } from "./conventions.js";
import { describeHost, hostKind } from "./host.js";
import { newerSetUp } from "./init.js";
import { FREE_LOCK, LOCK_BRANCH, LOCK_FILE } from "./lock.js";
import { findStandingNotes } from "./notes.js";
import { OPERATOR_SKILL_PATH } from "./operator-skill.js";
import type { Tracker } from "./ports/tracker.js";
import type { LockHolder, LockTake, TicketWorktree, Workspace } from "./ports/workspace.js";
import {
  CLAUDE_FILENAME,
  GH_FAILURE,
  IGNORED,
  type IgnoredDirectory,
  hasClaudePointer,
  readTargetFile,
  withoutClaudeSection,
  withoutIgnoreEntry,
} from "./readiness.js";
import { STATE_BRANCH } from "./resume.js";
import { nestedRunRefusal } from "./stage-guard.js";

/**
 * `ticket-runner remove`: take the pipeline out of a Target, so a human who
 * tried it on a repository of their own can undo it.
 *
 * It removes what it can prove the pipeline put there — what `init` wrote, and
 * what Runs left behind — and nothing else. What Planning shares with the
 * pipeline, the five triage labels other than in-progress, and what the
 * repository may have had before `init`, the two merge settings, stay, and so
 * does the work and the writing addressed to humans: `agent/` branches on
 * GitHub and their pull requests, the Notes issue, comments on issues. The
 * report names each of them, with what to do about it.
 *
 * Like `init` it commits nothing, and leaves the working tree changed for the
 * human to review. Unlike `init` it takes the Run lock, recording itself as
 * the holder, so that no Run starts on a Target that is being taken apart, and
 * the lock branch is the last thing it deletes. A removal that fails is
 * reported and the rest carry on; the lock is then released rather than
 * deleted, and running the command again is a first run over what is left.
 *
 * The Target's own files are read and written here rather than through a
 * port, for the reason `init` gives: setting a Target up and taking it out
 * again are nothing a Run does. Its branches, worktrees and label go through
 * the ports, which is what lets its tests drive it through fakes and a
 * temporary repository root, as `init`'s are.
 */

/** The pipeline's directory of worktrees, one `ticket-<n>` per Ticket. */
const WORKTREES_DIR = ".worktrees";

/** The pipeline's directory of Run logs and transcripts. */
const LOCAL_DIR = ".ticket-runner";

/** The files `init` writes that are wholly the pipeline's, whatever they now say. */
const PIPELINE_FILES = [CONFIG_FILENAME, CONVENTIONS_PATH, OPERATOR_SKILL_PATH];

const PASS = "✓";
const FAIL = "✗";

export interface RemoveOptions {
  repoRoot: string;
  /** The Version doing the removing, which the report's first line names (ADR-0007). */
  version: string;
  /** The pipeline's own repository, as `owner/name`, which the upgrade is named from. */
  repository?: string | undefined;
  /** Read before anything is removed, because it names the in-progress label. */
  config: Config;
  tracker: Tracker;
  workspace: Workspace;
  /** `-y` or `--yes`: go ahead without asking. */
  yes: boolean;
  /** Whether a human is there to answer the question, which a terminal says. */
  interactive: boolean;
  /** Put the question to that human, and give back what they typed. */
  ask: (question: string) => Promise<string>;
  /** The run id and command line the Run lock records while this holds it. */
  runId: string;
  command: string;
  /** The shell it was started in, which the Stage mark and the Host are read from. */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** What of the pipeline's a Target still has, as `remove` finds it. */
interface Found {
  /** Those of {@link PIPELINE_FILES} it has, as paths from the root. */
  files: string[];
  /**
   * `CLAUDE.md` as `init` left it: holding its section and more, holding
   * nothing else, pointing at the document in words `init` did not write, or
   * none of these.
   */
  claude: "section" | "whole" | "edited" | undefined;
  /** The gitignore entries still exactly as `init` writes them. */
  ignores: IgnoredDirectory[];
  /** Whether `.ticket-runner/` is there. */
  localDir: boolean;
  worktrees: TicketWorktree[];
  /** The local `agent/` branches no `ticket-<n>` worktree has checked out. */
  branches: string[];
  /** What `.worktrees/` holds besides the pipeline's worktrees. */
  besides: string[];
  /** Whether the Target has the in-progress label. */
  label: boolean;
  stateBranch: boolean;
}

/**
 * Take the pipeline out of the Target and report on it. Returns the exit code:
 * 0 when everything it set out to remove is gone or there was nothing to
 * remove, 1 when at least one removal failed, and 2 when it refused before
 * anything changed.
 */
export async function removeTarget(options: RemoveOptions): Promise<number> {
  const { repoRoot, config, tracker, workspace } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const env = options.env ?? process.env;
  const refuse = (message: string): number => {
    error(message);
    return 2;
  };

  // Before the first read of the Target, as `init` refuses it.
  const nested = nestedRunRefusal(env);
  if (nested !== undefined) return refuse(nested);

  // A cloud Host can delete no ref on the remote (ADR-0008), so it would leave
  // the lock and State branches behind whatever else it took out.
  if (hostKind(env) === "cloud") {
    return refuse(
      "Refusing to remove on a cloud Host: it can delete no branch on the remote, so the Run" +
        " lock and State branches would stay. Run `ticket-runner remove` on a workstation instead.",
    );
  }

  const authentication = await tracker.authentication();
  if (authentication !== "authenticated") {
    const { failure, remedy } = GH_FAILURE[authentication];
    return refuse(`Refusing to remove: ${failure} — ${remedy}, then \`ticket-runner remove\` again.`);
  }

  // A newer Version may have put things in the Target this one has never
  // heard of, and a removal that left them would report a Target it had not
  // emptied as done.
  const newer = newerSetUp(repoRoot, options.version);
  if (newer !== undefined) {
    const upgrade =
      options.repository === undefined
        ? "Upgrade `ticket-runner`"
        : `Upgrade with \`npm install -g "github:${options.repository}#semver:*"\``;
    return refuse(
      `Refusing to remove: ${newer.mark} set this Target up and this is ${newer.own}, so it may` +
        ` have left things this Version does not know to remove. ${upgrade}, then run` +
        " `ticket-runner remove` again.",
    );
  }

  const header = `ticket-runner ${options.version} remove · ${repoRoot}`;

  // Asked before the lock, so a Target the pipeline never touched is left
  // without a lock branch it never had.
  const before = await find(options);
  if (nothingFound(before) && !(await workspace.hasRemoteBranch(LOCK_BRANCH))) {
    log(header);
    logGroup(log, "Removed", []);
    logGroup(log, "GitHub", []);
    logGroup(log, "Left for you", await leftForYou(options, { removed: false }));
    log("");
    log("Nothing to remove: ticket-runner has not set this Target up.");
    return 0;
  }

  if (!options.yes && !options.interactive) {
    return refuse(
      "Refusing to remove: there is no terminal to ask whether to go ahead. Run" +
        " `ticket-runner remove --yes` to remove without asking.",
    );
  }

  const taken = await workspace.takeRunLock({
    pid: process.pid,
    command: options.command,
    runId: options.runId,
    startedAt: new Date().toISOString(),
  });
  if (taken.outcome !== "taken") return refuse(lockRefusal(taken));

  let found: Found;
  try {
    const refusal = await heldWorkRefusal(options);
    if (refusal !== undefined) {
      await workspace.releaseRunLock();
      return refuse(refusal);
    }

    // Found again under the lock, which is what it removes: a Run could have
    // come and gone between the first look and the take.
    found = await find(options);
    log(header);
    if (!options.yes) {
      logGroup(log, "About to remove", planned(repoRoot, found, config));
      log("");
      const answer = await options.ask("Remove all of this? Nothing will be committed. [y/N] ");
      if (!/^y(es)?$/i.test(answer.trim())) {
        await workspace.releaseRunLock();
        return refuse(
          "Nothing was removed. Run `ticket-runner remove` again when you want it gone.",
        );
      }
    }
  } catch (failure) {
    // Nothing is removed yet, so the lock is all there is to put back.
    await workspace.releaseRunLock();
    throw failure;
  }

  const outcome = await removeFound(options, found);
  logGroup(log, "Removed", outcome.removed);
  logGroup(log, "GitHub", outcome.github);
  logGroup(
    log,
    "Left for you",
    [
      ...outcome.left,
      ...(await leftForYou(options, {
        removed: outcome.removed.some((line) => line.startsWith(PASS)),
        states: outcome.states,
      })),
    ],
  );

  log("");
  if (outcome.failed === 0) {
    log("Done: the pipeline has gone from this Target.");
    return 0;
  }
  log(
    `Not done: ${outcome.failed} ${outcome.failed === 1 ? "removal" : "removals"} failed — run` +
      " `ticket-runner remove` again to remove what is left.",
  );
  return 1;
}

/**
 * What stops the removal once the lock is held: work a Run or a human still
 * has in hand, which removing the pipeline would take away from under them.
 */
async function heldWorkRefusal({
  config,
  tracker,
  workspace,
  repoRoot,
}: RemoveOptions): Promise<string | undefined> {
  const stranded = (await tracker.listCandidates(config.labels.inProgress))
    .map((candidate) => candidate.number)
    .sort((a, b) => a - b);
  if (stranded.length > 0) {
    const named = stranded.map((ticket) => `#${ticket}`);
    const one = named.length === 1;
    const listed = one ? named[0] : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
    const them = one ? "it" : "them";
    return (
      `Refusing to remove: ${listed} still ${one ? "carries" : "carry"} the` +
      ` \`${config.labels.inProgress}\` label, so ${one ? "it is a Stranded Ticket" : "they are Stranded Tickets"}` +
      ` a Run was killed holding. Finish ${them} with \`ticket-runner run\`, or relabel ${them},` +
      " then run `ticket-runner remove` again."
    );
  }

  const holding = (await workspace.ticketWorktrees()).filter(
    (worktree) => worktree.uncommitted || worktree.unpushed,
  );
  if (holding.length === 0) return undefined;
  return [
    "Refusing to remove: these worktrees hold work GitHub does not have, which removing them would lose:",
    ...holding.map((worktree) => {
      const held = [
        ...(worktree.uncommitted ? ["uncommitted changes"] : []),
        ...(worktree.unpushed ? ["commits its branch on the remote does not have"] : []),
      ];
      return `  ${shown(repoRoot, worktree.path)}: ${held.join(", and ")}`;
    }),
    "Commit and push it, or discard it, then run `ticket-runner remove` again.",
  ].join("\n");
}

/**
 * Who holds the lock `remove` did not get, named as `stop` names a holder, and
 * what the human does about it. None of them is taken over: a lock whose
 * process has gone may still name Tickets somebody means to finish.
 */
function lockRefusal(taken: Exclude<LockTake, { outcome: "taken" }>): string {
  const { holder } = taken;
  const again = "then run `ticket-runner remove` again.";
  const release =
    `commit a \`${LOCK_FILE}\` that reads \`${FREE_LOCK}\` to the \`${LOCK_BRANCH}\` branch,` +
    ` ${again}`;
  if (taken.outcome === "abandoned") {
    return (
      `Refusing to remove: ${described(holder)} holds the Run lock, but its process on this` +
      " Host has gone. `remove` takes over no lock: start `ticket-runner run` to take it over" +
      ` and finish what it held, or ${release}`
    );
  }
  if (taken.onAnotherHost) {
    return (
      `Refusing to remove: \`${holder.command}\` (run ${holder.runId}) holds the Run lock from` +
      ` ${describeHost(holder.host)}, started ${holder.startedAt}. Wait for it to finish or, if` +
      ` it is gone, ${release}`
    );
  }
  return (
    `Refusing to remove: ${described(holder)} holds the Run lock on this Host, started` +
    ` ${holder.startedAt}. Wait for it to finish, or ask it to with \`ticket-runner stop\`, ${again}`
  );
}

/** A holder on this Host, in the three things the lock knows about it. */
function described(holder: LockHolder): string {
  return `\`${holder.command}\` (run ${holder.runId}, pid ${holder.pid})`;
}

/** Everything of the pipeline's the Target still has. */
async function find({ repoRoot, config, tracker, workspace }: RemoveOptions): Promise<Found> {
  const worktrees = await workspace.ticketWorktrees();
  const checkedOut = new Set(worktrees.map((worktree) => worktree.branch));
  const kept = new Set(worktrees.map((worktree) => basename(worktree.path)));
  const besides = listDirectory(join(repoRoot, WORKTREES_DIR)).filter((name) => !kept.has(name));

  const gitignore = readTargetFile(join(repoRoot, ".gitignore")) ?? "";
  const ignores = IGNORED.filter(
    (entry) =>
      withoutIgnoreEntry(gitignore, entry) !== undefined &&
      // Kept while anything else is under the directory, which it keeps out of
      // a commit as much as the pipeline's worktrees.
      (entry.line !== `${WORKTREES_DIR}/` || besides.length === 0),
  );

  return {
    files: PIPELINE_FILES.filter((path) => existsSync(join(repoRoot, path))),
    claude: claudeFound(readTargetFile(join(repoRoot, CLAUDE_FILENAME))),
    ignores,
    localDir: existsSync(join(repoRoot, LOCAL_DIR)),
    worktrees,
    branches: (await workspace.listBranches(AGENT_BRANCH_PREFIX))
      .filter((branch) => !checkedOut.has(branch))
      .sort(),
    besides,
    label: (await tracker.listLabels()).includes(config.labels.inProgress),
    stateBranch: await workspace.hasRemoteBranch(STATE_BRANCH),
  };
}

function claudeFound(claude: string | undefined): Found["claude"] {
  if (claude === undefined) return undefined;
  const rest = withoutClaudeSection(claude);
  if (rest !== undefined) return rest.trim() === "" ? "whole" : "section";
  return hasClaudePointer(claude) ? "edited" : undefined;
}

/** Whether nothing `remove` would take out is there; what it leaves does not count. */
function nothingFound(found: Found): boolean {
  return (
    found.files.length === 0 &&
    (found.claude === undefined || found.claude === "edited") &&
    found.ignores.length === 0 &&
    !found.localDir &&
    found.worktrees.length === 0 &&
    found.branches.length === 0 &&
    !found.label &&
    !found.stateBranch
  );
}

/** What the question lists, in the order the removal goes. */
function planned(repoRoot: string, found: Found, config: Config): string[] {
  return [
    ...found.files,
    ...(found.claude === "whole"
      ? [`${CLAUDE_FILENAME}, because the section \`init\` wrote is all it holds`]
      : []),
    ...(found.claude === "section" ? [claudeLine(found)] : []),
    ...(found.localDir ? [`${LOCAL_DIR}/`] : []),
    ...found.worktrees.map((worktree) => worktreeLine(repoRoot, worktree)),
    ...found.branches.map((branch) => `${branch}, a local branch`),
    ...(found.ignores.length > 0 ? [".gitignore: the entries `init` wrote"] : []),
    "any directory this leaves empty",
    ...(found.label ? [`the \`${config.labels.inProgress}\` label`] : []),
    ...(found.stateBranch ? [`the \`${STATE_BRANCH}\` branch`] : []),
    `the \`${LOCK_BRANCH}\` branch`,
  ];
}

function claudeLine(found: Found): string {
  return found.claude === "whole"
    ? `${CLAUDE_FILENAME}: deleted, because the section \`init\` wrote was all it held`
    : `${CLAUDE_FILENAME}: the section pointing at ${CONVENTIONS_PATH}`;
}

function worktreeLine(repoRoot: string, worktree: TicketWorktree): string {
  const path = shown(repoRoot, worktree.path);
  return worktree.branch === undefined ? path : `${path}, and its branch ${worktree.branch}`;
}

/** What the removal did, group by group, and what it has to say beyond that. */
interface Removal {
  removed: string[];
  github: string[];
  /** What it left, and why, where it was one of the things it set out to remove. */
  left: string[];
  failed: number;
  /** The Tickets whose State files went with the state branch. */
  states: number[];
}

/**
 * Remove everything `found` holds, carrying on past each failure, and the lock
 * branch last of all: deleted where every other removal went, and released to
 * free where one did not, so the next `remove` can take it again.
 */
async function removeFound(options: RemoveOptions, found: Found): Promise<Removal> {
  const { repoRoot, config, tracker, workspace } = options;
  const removal: Removal = { removed: [], github: [], left: [], failed: 0, states: [] };
  const attempt = async (
    group: string[],
    line: string,
    act: () => unknown,
  ): Promise<boolean> => {
    try {
      await act();
      group.push(`${PASS} ${line}`);
      return true;
    } catch (failure) {
      removal.failed += 1;
      group.push(`${FAIL} ${line}: ${reason(failure)}`);
      return false;
    }
  };
  const emptied = new Set<string>();

  for (const path of found.files) {
    const gone = await attempt(removal.removed, path, () => rmSync(join(repoRoot, path)));
    if (gone) emptied.add(dirname(path));
  }
  if (found.claude === "whole" || found.claude === "section") {
    await attempt(removal.removed, claudeLine(found), () => {
      const path = join(repoRoot, CLAUDE_FILENAME);
      if (found.claude === "whole") rmSync(path);
      else writeFileSync(path, withoutClaudeSection(readTargetFile(path) ?? "") ?? "");
    });
  }
  if (found.localDir) {
    await attempt(removal.removed, `${LOCAL_DIR}/`, () =>
      rmSync(join(repoRoot, LOCAL_DIR), { recursive: true, force: true }),
    );
  }

  for (const worktree of found.worktrees) {
    await attempt(removal.removed, worktreeLine(repoRoot, worktree), () =>
      workspace.removeWorktree(worktree),
    );
  }
  for (const branch of found.branches) {
    await attempt(removal.removed, `${branch}, a local branch`, () =>
      workspace.deleteBranch(branch),
    );
  }

  // Asked of the directory now rather than taken from what was found: a
  // worktree that would not go keeps it, and its entry, for the next run.
  const worktreesDir = join(repoRoot, WORKTREES_DIR);
  const worktreesLeft = listDirectory(worktreesDir);
  if (existsSync(worktreesDir) && worktreesLeft.length === 0) {
    await attempt(removal.removed, `${WORKTREES_DIR}/, left empty`, () => rmdirSync(worktreesDir));
  } else if (found.besides.length > 0) {
    removal.left.push(
      `${WORKTREES_DIR}/: holds ${found.besides.join(", ")} besides the pipeline's worktrees, so` +
        " it stays, and so does its `.gitignore` entry",
    );
  }

  const ignores = found.ignores.filter(
    (entry) => entry.line !== `${WORKTREES_DIR}/` || worktreesLeft.length === 0,
  );
  if (ignores.length > 0) await removeIgnores(repoRoot, ignores, removal.removed, attempt);

  for (const directory of prunable(repoRoot, emptied)) {
    await attempt(removal.removed, `${directory}/, left empty`, () =>
      rmdirSync(join(repoRoot, directory)),
    );
  }

  if (found.label) {
    await attempt(
      removal.github,
      `the \`${config.labels.inProgress}\` label, from every issue that wore it`,
      () => tracker.deleteLabel(config.labels.inProgress),
    );
  }
  if (found.stateBranch) {
    // Read before the branch goes, because it is the only place they are named.
    const states = await workspace.readAllStates().catch(() => []);
    const gone = await attempt(removal.github, `the \`${STATE_BRANCH}\` branch`, () =>
      workspace.deleteRemoteBranch(STATE_BRANCH),
    );
    if (gone) {
      removal.states = states.map((file) => (file.readable ? file.state.ticket : file.ticket));
    }
  }

  const deleted =
    removal.failed === 0 &&
    (await attempt(removal.github, `the \`${LOCK_BRANCH}\` branch`, () =>
      workspace.deleteRemoteBranch(LOCK_BRANCH),
    ));
  if (!deleted) {
    const released = await attempt(removal.github, "the Run lock, released to free", () =>
      workspace.releaseRunLock(),
    );
    if (released) {
      removal.left.push(
        `${LOCK_BRANCH}: released rather than deleted, because a removal above failed —` +
          " `ticket-runner remove` again deletes it with the rest",
      );
    }
  }
  return removal;
}

/**
 * Take `init`'s entries out of the gitignore, and the gitignore with them when
 * they were all it held.
 */
async function removeIgnores(
  repoRoot: string,
  ignores: IgnoredDirectory[],
  removed: string[],
  attempt: (group: string[], line: string, act: () => unknown) => Promise<boolean>,
): Promise<void> {
  const path = join(repoRoot, ".gitignore");
  let rest = readTargetFile(path) ?? "";
  for (const entry of ignores) rest = withoutIgnoreEntry(rest, entry) ?? rest;

  const entries = ignores.map((entry) => `\`${entry.line}\``).join(" and ");
  const line =
    rest.trim() === ""
      ? ".gitignore: deleted, because the entries `init` wrote were all it held"
      : `.gitignore: ${entries}, with the ${ignores.length === 1 ? "comment" : "comments"} \`init\` wrote ${ignores.length === 1 ? "it" : "them"} under`;
  await attempt(removed, line, () => {
    if (rest.trim() === "") rmSync(path);
    else writeFileSync(path, rest);
  });
}

/**
 * The directories, as paths from the root, that removing files from `emptied`
 * left with nothing in them, each walked up from the file's own until one
 * still holds something: each held what was removed, so none of them was
 * empty before, and a parent goes only once its children have.
 */
function prunable(repoRoot: string, emptied: Set<string>): string[] {
  const pruned: string[] = [];
  const isEmpty = (directory: string): boolean =>
    existsSync(join(repoRoot, directory)) &&
    listDirectory(join(repoRoot, directory)).every((name) =>
      pruned.includes(join(directory, name)),
    );
  for (const start of emptied) {
    for (
      let directory = start;
      directory !== "." && !pruned.includes(directory) && isEmpty(directory);
      directory = dirname(directory)
    ) {
      pruned.push(directory);
    }
  }
  return pruned;
}

/**
 * The lines of the last group: what the pipeline cannot prove it put there,
 * or leaves on purpose, each with what to do about it.
 *
 * A GitHub question that fails is named in its line rather than failing the
 * report: nothing here was a removal, so nothing here changes the exit code.
 */
async function leftForYou(
  { repoRoot, config, tracker, workspace }: RemoveOptions,
  { removed, states = [] }: { removed: boolean; states?: number[] },
): Promise<string[]> {
  const lines: string[] = [];
  const asking = async (what: string, ask: () => Promise<string[]>): Promise<void> => {
    try {
      lines.push(...(await ask()));
    } catch (failure) {
      lines.push(`${what}: could not be listed — ${reason(failure)}`);
    }
  };

  await asking("labels", async () => {
    const existing = new Set(await tracker.listLabels());
    return Object.entries(config.labels)
      .filter(([role, name]) => role !== "inProgress" && existing.has(name))
      .map(
        ([, name]) =>
          `label \`${name}\`: Planning uses it too — \`gh label delete ${name}\` removes it`,
      );
  });
  lines.push(
    "merge settings: squash merging and deleting a pull request's branch when it merges are" +
      " left as they are, since this repository may have had them before `init` —" +
      " `gh repo edit --enable-squash-merge=false` or" +
      " `gh repo edit --delete-branch-on-merge=false` turns one off",
  );
  await asking("branches on GitHub", async () => {
    const branches = (await workspace.listRemoteBranches(AGENT_BRANCH_PREFIX)).sort();
    if (branches.length === 0) return [];
    const pulls = await tracker.openPullRequests();
    return branches.map((branch) => {
      const pull = pulls.find((candidate) => candidate.head === branch);
      return pull === undefined
        ? `branch \`${branch}\` on GitHub: no pull request is open on it`
        : `branch \`${branch}\` on GitHub: pull request #${pull.number} is open on it`;
    });
  });
  await asking("the Notes issue", async () => {
    const notes = await findStandingNotes({ tracker, needsTriage: config.labels.needsTriage });
    return notes === undefined
      ? []
      : [`issue #${notes}: the standing Notes issue, left open with the Notes on it`];
  });

  if (states.length > 0) {
    lines.push(
      `${states.map((ticket) => `#${ticket}`).join(", ")}: no Run can resume ${states.length === 1 ? "it" : "them"}` +
        ` any more, because ${states.length === 1 ? "its State file" : "their State files"}, and any` +
        ` hand-off transcripts kept beside ${states.length === 1 ? "it" : "them"}, went with \`${STATE_BRANCH}\``,
    );
  }

  const claude = readTargetFile(join(repoRoot, CLAUDE_FILENAME));
  if (claudeFound(claude) === "edited") {
    lines.push(
      `${CLAUDE_FILENAME}: the section pointing at ${CONVENTIONS_PATH} is not the text \`init\`` +
        " writes, so it stays",
    );
  }
  const gitignore = (readTargetFile(join(repoRoot, ".gitignore")) ?? "").split("\n");
  for (const entry of IGNORED) {
    const kept = gitignore.some((line) => line.trim() === entry.line);
    if (kept && withoutIgnoreEntry(gitignore.join("\n"), entry) === undefined) {
      lines.push(
        `.gitignore: \`${entry.line}\` stays, because it is not under the comment \`init\`` +
          " writes it with",
      );
    }
  }

  if (removed) {
    lines.push(
      "nothing was committed: review the changes with `git status` and commit them yourself",
    );
  }
  return lines;
}

/** One headed group of the report, indented under its heading. */
function logGroup(log: (line: string) => void, heading: string, lines: string[]): void {
  log("");
  log(`${heading}:`);
  for (const line of lines.length === 0 ? ["nothing to remove"] : lines) log(`  ${line}`);
}

/** The names in a directory, and none where there is no directory to read. */
function listDirectory(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

/**
 * A path as the report names it, from the Target's root. Git names a
 * worktree by its real path, so a root reached through a symlink is resolved
 * before a path it does not start with is measured from it.
 */
function shown(repoRoot: string, path: string): string {
  const from = relative(repoRoot, path);
  if (!from.startsWith("..")) return from;
  try {
    return relative(realpathSync(repoRoot), path);
  } catch {
    return path;
  }
}

function reason(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
