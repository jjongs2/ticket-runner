import { dirname } from "node:path";
import { execOrThrow } from "./exec.js";

/**
 * The main checkout, even when the command was started from inside one of the
 * pipeline's own worktrees.
 *
 * `--show-toplevel` would answer with the worktree. The Run lock, `.worktrees/`
 * and the run logs all have to land in one place per repo rather than one place
 * per worktree, or two Runs started from different directories of the same
 * clone would never see each other.
 */
export async function findRepoRoot(cwd?: string): Promise<string> {
  const { stdout } = await execOrThrow(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd === undefined ? {} : { cwd },
  );
  return dirname(stdout.trim());
}
