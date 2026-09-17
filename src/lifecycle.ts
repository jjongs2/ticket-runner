/**
 * Where a Ticket was when it failed. Named after the lifecycle step, not the
 * Stage, because Checks, rebase, PR and CI are not agent sessions.
 */
export type FailurePoint =
  | "setup"
  | "implement"
  | "checks"
  | "verify"
  | "rebase"
  | "pr"
  | "ci"
  | "merge";
