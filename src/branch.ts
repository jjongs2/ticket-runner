import { join } from "node:path";

/** Where every branch a Run creates lives, and nothing else branches. */
export const AGENT_BRANCH_PREFIX = "agent/";

/** The longest slug the implement Stage may name a branch with. */
export const MAX_SLUG_LENGTH = 40;

/**
 * The shape a branch slug takes: lowercase ASCII words joined by single
 * dashes. Stated once, for the schema, the prompt and the check alike.
 */
export const SLUG_SHAPE = "^[a-z0-9]+(-[a-z0-9]+)*$";

const SLUG = new RegExp(SLUG_SHAPE);

/**
 * `agent/<n>`, the branch a Run claims a Ticket on. Nothing is cut from the
 * Ticket title: a title in another script than ASCII left nothing to cut, and
 * the implement Stage, which has read the Ticket, names the branch instead
 * ({@link namedBranch}).
 */
export function claimBranch(ticket: number): string {
  return `${AGENT_BRANCH_PREFIX}${ticket}`;
}

/** `agent/<n>-<slug>`, the name the implement Stage's slug gives the branch. */
export function namedBranch(ticket: number, slug: string): string {
  return `${claimBranch(ticket)}-${slug}`;
}

/**
 * What the implement Stage answered for the branch: nothing to go on, a slug in
 * shape, or one out of shape, which the Run logs as why the branch kept its
 * name. Forgiving as the title is: output that is not an object, and a missing,
 * blank or non-string answer, each count as no slug at all.
 */
export type SlugAnswer =
  | { kind: "empty" }
  | { kind: "slug"; slug: string }
  | { kind: "out-of-shape"; answered: string };

export function parseBranchSlug(result: unknown): SlugAnswer {
  if (typeof result !== "object" || result === null) return { kind: "empty" };
  const raw = (result as { branch?: unknown }).branch;
  if (typeof raw !== "string") return { kind: "empty" };
  const answered = raw.trim();
  if (answered === "") return { kind: "empty" };
  if (answered.length > MAX_SLUG_LENGTH || !SLUG.test(answered)) {
    return { kind: "out-of-shape", answered };
  }
  return { kind: "slug", slug: answered };
}

/** The gitignored worktree a Ticket is implemented in. */
export function worktreePath(repoRoot: string, ticket: number): string {
  return join(repoRoot, ".worktrees", `ticket-${ticket}`);
}

/**
 * The gitignored worktree a Check runs in at a merge-base with the base branch,
 * beside the Tickets' own: named for the commit, shortened as git shortens one.
 */
export function baseWorktreePath(repoRoot: string, commit: string): string {
  return join(repoRoot, ".worktrees", `base-${commit.slice(0, 12)}`);
}
