import { join } from "node:path";

const MAX_SLUG_LENGTH = 40;

/**
 * The Ticket title as a branch-safe slug: lowercase kebab-case, cut to
 * {@link MAX_SLUG_LENGTH} at a word boundary so the name stays readable.
 */
export function slug(title: string): string {
  const kebab = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (kebab === "") return "ticket";
  if (kebab.length <= MAX_SLUG_LENGTH) return kebab;

  const cut = kebab.slice(0, MAX_SLUG_LENGTH);
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
}

/** Where every branch a Run creates lives, and nothing else branches. */
export const AGENT_BRANCH_PREFIX = "agent/";

/** `agent/<n>-<slug>`, the name reserved for pipeline Runs. */
export function branchName(ticket: number, title: string): string {
  return `${AGENT_BRANCH_PREFIX}${ticket}-${slug(title)}`;
}

/** The gitignored worktree a Ticket is implemented in. */
export function worktreePath(repoRoot: string, ticket: number): string {
  return join(repoRoot, ".worktrees", `ticket-${ticket}`);
}
