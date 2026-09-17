/**
 * Where a Ticket was when it failed. Named after the lifecycle step, not the
 * Stage, because Checks, rebase, PR and CI are not agent sessions.
 */
export type FailurePoint =
  | "setup"
  | "implement"
  | "checks"
  | "verify"
  | "fix"
  | "rebase"
  | "pr"
  | "ci"
  | "merge";

/**
 * The three failures a fix Stage is given a second try at, and what the fix
 * prompt calls each of them.
 *
 * Every other failure ends the Ticket where it stands, because none of them is
 * a defect in the code a fresh session could go and mend: a rebase conflict, a
 * Stage that never came back, a Verdict with no evidence in it, a pull request
 * whose checks timed out or never ran.
 */
export type FailureKind = "failed-check" | "unmet-criteria" | "failed-ci";
