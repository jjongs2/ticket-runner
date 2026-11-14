/**
 * A fault of GitHub's or of the Host's, which says nothing about the Ticket.
 *
 * Read off what `gh` and git print, since that is all either says about why it
 * failed: GitHub answering with a 5xx status or with a response that is not
 * complete JSON, and git unable to connect to or authenticate with the remote.
 * A Ticket that meets one is released rather than handed off, as over a
 * failing base branch: a human relabelling it would change nothing in its work,
 * and every Ticket behind it would meet the same fault.
 *
 * Everything else a command prints is the Ticket's to answer for, as before: a
 * GitHub 4xx, and a git failure that persists, such as a pull refused over a
 * base branch that has really diverged.
 */

/** Whose side the fault is on: GitHub's, or the git remote's. */
export type FaultSide = "github" | "remote";

/** A command that failed for a fault outside the Ticket, and how it failed. */
export class OutsideFault extends Error {
  constructor(
    readonly side: FaultSide,
    /** The command as a human would type it, on one line. */
    readonly command: string,
    /** The first line of what it printed, which is what the Run's last line quotes. */
    readonly line: string,
    message: string,
  ) {
    super(message);
    this.name = "OutsideFault";
  }
}

/**
 * GitHub failing on its own side: a 5xx status as `gh` reports it, and a
 * response `gh` could not read as JSON, which is how a gateway that cut the
 * answer short shows.
 */
const GITHUB_FAULTS = [
  /\bHTTP 5\d\d\b/,
  /unexpected end of JSON input/i,
  /invalid character .{1,12} looking for beginning of value/,
];

/**
 * git unable to reach the remote or to be let in. `Could not read from remote
 * repository` is not among them: git says it after a repository that does not
 * exist as well, which no wait mends.
 */
const REMOTE_FAULTS = [
  /Permission denied \(publickey/i,
  /Could not resolve host/i,
  /Authentication failed/i,
  /could not read (Username|Password) for/i,
  /Connection refused/i,
  /Connection timed out/i,
  /Operation timed out/i,
  /Connection reset by peer/i,
  /Failed to connect to/i,
  /The requested URL returned error: 5\d\d/,
  /RPC failed; HTTP 5\d\d/,
];

/** Whether `gh` printed a fault of GitHub's own. */
export function isGitHubFault(output: string): boolean {
  return GITHUB_FAULTS.some((pattern) => pattern.test(output));
}

/** Whether git printed that it could not connect to or authenticate with the remote. */
export function isRemoteFault(output: string): boolean {
  return REMOTE_FAULTS.some((pattern) => pattern.test(output));
}

/**
 * Whose fault a failed `command` is, from what it printed, or nothing when it
 * is no fault outside the Ticket. Only `gh` speaks for GitHub and only git for
 * the remote, so a Check that happens to print the same words is never one.
 */
export function faultSide(command: string, output: string): FaultSide | undefined {
  if (command === "gh" && isGitHubFault(output)) return "github";
  if (command === "git" && isRemoteFault(output)) return "remote";
  return undefined;
}

/** The first line of `output` with anything on it, trimmed; empty when there is none. */
export function firstLine(output: string): string {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}
