import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "./adapters/exec.js";

/**
 * Which Version this copy of the pipeline is (ADR-0007).
 *
 * Computed once, in the CLI, and handed to the Run and to `init` the way the
 * run id is. Nothing downstream asks again: every line one Run stamps — its
 * summary, each Progress comment, each State file, the file beside its
 * transcripts — has to say the same thing, and the only way to promise that is
 * to read it once.
 *
 * No port describes this. The number is in this package's own `package.json`
 * and the commit is in this checkout's own git directory, and neither is a
 * Target's file: the pipeline's own files it reads itself (ADR-0004).
 */

/** The package root: the directory this package's `package.json` sits in. */
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** What a copy with no number to read calls itself, rather than guessing one. */
const UNKNOWN = "unknown";

/**
 * The Version, as everything this Run writes will report it.
 *
 * An installed copy is its number and nothing else, because a machine installs
 * a tag: two machines that say `0.4.0` run the same code. A development
 * checkout runs whatever commit it has, so it adds that commit in semver's
 * build-metadata position and a `dirty` mark when the tree has uncommitted
 * changes — `0.4.0`, `0.4.0+331d79c`, `0.4.0+331d79c.dirty`.
 */
export async function pipelineVersion(packageRoot: string = PACKAGE_ROOT): Promise<string> {
  const number = packageNumber(packageRoot);
  const commit = await checkoutCommit(packageRoot);
  return commit === undefined ? number : `${number}+${commit}`;
}

/** The number in `package.json`, which is the whole of an installed Version. */
function packageNumber(packageRoot: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  } catch {
    return UNKNOWN;
  }
  const version =
    parsed !== null && typeof parsed === "object" && "version" in parsed
      ? parsed.version
      : undefined;
  return typeof version === "string" && version !== "" ? version : UNKNOWN;
}

/**
 * The commit a development checkout runs, with a `dirty` mark where the tree
 * has uncommitted changes. Undefined for an installed copy, and for a checkout
 * git could not be asked about.
 *
 * Nothing is reported on a guess: a checkout whose status could not be read
 * gets no commit at all, because a transcript naming a commit the code did not
 * match is worse than one naming none.
 */
async function checkoutCommit(packageRoot: string): Promise<string | undefined> {
  // A package root that is a git repository is a development checkout, which a
  // global install never is. `.git` is a directory in a clone and a file in a
  // worktree, and its presence is the whole question.
  if (!existsSync(join(packageRoot, ".git"))) return undefined;

  const commit = await git(packageRoot, ["rev-parse", "--short", "HEAD"]);
  if (commit === undefined || commit === "") return undefined;
  const status = await git(packageRoot, ["status", "--porcelain"]);
  if (status === undefined) return undefined;
  return status === "" ? commit : `${commit}.dirty`;
}

/** What git said, or undefined where it failed or could not be run at all. */
async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { exitCode, stdout } = await exec("git", args, { cwd });
    return exitCode === 0 ? stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}
