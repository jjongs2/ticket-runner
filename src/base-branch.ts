import type { Config } from "./config.js";
import type { Tracker } from "./ports/tracker.js";

/**
 * The branch a Run works against: the one it branches Tickets from, rebases
 * them onto, targets their pull requests at, and pulls the main checkout to
 * once they merge.
 *
 * The Target's default branch on GitHub, so a repository on `master` needs no
 * config file at all; a `baseBranch` in the config file wins, for the repo
 * whose merges go somewhere other than where GitHub points `HEAD`.
 *
 * Asked once at the start of a Run and carried from there: it is a remote
 * round-trip, and every Ticket of a Run merges into the same branch.
 */
export async function resolveBaseBranch(
  tracker: Tracker,
  config: Pick<Config, "baseBranch">,
): Promise<string> {
  return config.baseBranch ?? (await tracker.defaultBranch());
}
