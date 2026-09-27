import { describeHost } from "./host.js";
import { LOCK_BRANCH } from "./lock.js";
import type { LockHolder, Workspace } from "./ports/workspace.js";

/**
 * A Stop: how a human asks for one, and how a Run comes to hear about it.
 *
 * SIGTERM is the whole of what a Stop is on the wire (ADR-0006): no file beside
 * the Run lock, and no meaning for Ctrl+C. So both ends of it are small enough
 * to live together — `ticket-runner stop` reads the lock and signals the
 * process it names, and the Run listening at the other end turns that signal
 * into something a test can raise without a process to send one to. What the
 * Run then does with it — finish the Tickets its Lanes hold and claim nothing
 * more — is the Run's own business, and lives with the Run.
 */

/** A Stop that reached a Run, and when it did. */
export interface Stop {
  /** ISO-8601, so a summary and the run id above it read in the same clock. */
  at: string;
}

/** Where SIGTERM comes from: the process itself, unless a test is watching. */
export interface StopSource {
  on(signal: "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGTERM", listener: () => void): unknown;
}

/**
 * The one Stop a Run can be asked for.
 *
 * A Stop cannot be taken back and never arrives twice: a second SIGTERM is
 * ignored rather than escalated to a kill. That is dropped here, once, rather
 * than guarded against at each of the places a Run acts on the first one.
 */
export class StopSignal {
  private stop: Stop | undefined;

  /** What the first request has yet to reach. Emptied as it does. */
  private readonly watchers: ((stop: Stop) => void)[] = [];

  /** Ask the Run to stop. Every request after the first changes nothing. */
  request(at: Date = new Date()): void {
    if (this.stop !== undefined) return;
    this.stop = { at: at.toISOString() };
    for (const watcher of this.watchers.splice(0)) watcher(this.stop);
  }

  /**
   * Be told when the Stop arrives, or at once when it already has.
   *
   * A watcher rather than something a Run polls, because what a Run has to
   * report about a Stop — the Tickets its Lanes were holding — is true only at
   * the moment it arrived: by the time the Run next looks, those are the Lanes
   * that have come back.
   */
  watch(watcher: (stop: Stop) => void): void {
    if (this.stop !== undefined) {
      watcher(this.stop);
      return;
    }
    this.watchers.push(watcher);
  }
}

/**
 * Hear SIGTERM as a Stop until the returned function is called.
 *
 * Listening at all is the whole of the difference between a Stop and a kill:
 * with a handler on it, SIGTERM no longer ends the process. It is stopped when
 * the Run ends, because a signal handler holds the event loop open — a Run that
 * kept listening would print its summary and never exit.
 */
export function listenForStop(signal: StopSignal, source: StopSource = process): () => void {
  const stop = (): void => signal.request();
  source.on("SIGTERM", stop);
  return () => {
    source.off("SIGTERM", stop);
  };
}

/**
 * The one line a Run logs when a Stop reaches it.
 *
 * It leads with the Tickets the Lanes hold because they are the only thing
 * about a Stop that is not already known: the request itself came from the
 * human reading the line, and what is left of the transcript is theirs.
 */
export function stopLine(busy: number[]): string {
  const held = busy.length === 0 ? "nothing" : busy.map((ticket) => `#${ticket}`).join(" ");
  return `${held} left to finish · stopped`;
}

/** What `ticket-runner stop` needs: the Target's lock, and seams for tests. */
export interface StopRequest {
  /** Where the Run lock is read from, and which Host is asking. */
  workspace: Workspace;
  /** How the Stop is delivered. A real SIGTERM by default. */
  send?: (pid: number) => void;
  log?: (line: string) => void;
  /** Refusals, which the CLI puts on stderr as it always has. */
  error?: (line: string) => void;
}

/**
 * Ask the Run holding this Target's lock to stop, and answer with an exit code.
 *
 * A thin wrapper over the lock, and deliberately nothing more: no config file,
 * no `gh` and no Target readiness, because a human reaching for this has a Run
 * they want to end rather than a Target they want checked. Repeating it is
 * harmless — the second SIGTERM is one the Run ignores (ADR-0006) — so it says
 * the same thing every time rather than reporting a Stop already asked for.
 */
export async function requestStop({
  workspace,
  send = sendStop,
  log = (line: string) => console.log(line),
  error = (line: string) => console.error(line),
}: StopRequest): Promise<number> {
  const held = await workspace.runLockHolder();
  if (held === undefined) {
    error(
      `No Run to stop: nothing holds the Run lock on the \`${LOCK_BRANCH}\` branch, or the` +
        " Run on this Host that left it there is gone. A lock like that is the next Run's to" +
        " reclaim, so nothing here removes it.",
    );
    return 2;
  }

  // A Stop is a signal to a process, and only the Host the process runs on can
  // send one (ADR-0006). A pid read off another Host's lock is a stranger's
  // here, if it is anybody's.
  const { holder, onAnotherHost } = held;
  if (onAnotherHost) {
    error(
      `\`${holder.command}\` (run ${holder.runId}) holds the Run lock from` +
        ` ${describeHost(holder.host)}, started ${holder.startedAt}. Only that Host can send` +
        " it a Stop: `ticket-runner stop` there, or its Operator on a cloud Host. Nothing" +
        " was sent.",
    );
    return 2;
  }

  // A Run given one Ticket takes no more whatever happens, so a Stop would ask
  // it for what it is already doing. It is left alone rather than signalled so
  // that the answer says which Run is running, not just that nothing happened.
  if (namesOneTicket(holder.command)) {
    error(
      `${describeHolder(holder)} holds the Run lock, and a Run given one Ticket ends with it anyway.` +
        " Nothing was sent.",
    );
    return 2;
  }

  try {
    send(holder.pid);
  } catch (failure) {
    // The Run can end between the liveness check and the signal, and one
    // started by another user cannot be signalled from this shell at all.
    error(`Could not ask ${describeHolder(holder)} to stop: ${reason(failure)}`);
    return 2;
  }

  log(
    `${describeHolder(holder)} will stop once the Tickets it holds are finished. It claims no more.`,
  );
  log(
    "Ctrl+C in that Run's own terminal stops it at once instead, at the cost of killing the" +
      " Stages it is running and leaving their Tickets stranded for the next Run.",
  );
  return 0;
}

/**
 * Which Run, in the three things the lock knows about it: how `stop` names a
 * holder on this Host, and `remove` too.
 */
export function describeHolder(holder: LockHolder): string {
  return `\`${holder.command}\` (run ${holder.runId}, pid ${holder.pid})`;
}

/**
 * Whether the command line the lock recorded is a `ticket <n>` rather than a `run`.
 *
 * The lock records the line, not the work, so this is where the two are told
 * apart. Anything it cannot read as a `ticket` counts as a `run`: the cost of
 * guessing wrong is one misleading line, since a `ticket` hears SIGTERM as a
 * Stop too, where refusing to send would leave a real Run running.
 */
function namesOneTicket(command: string): boolean {
  return command.trim().split(/\s+/)[1] === "ticket";
}

/** SIGTERM to the process the lock names, which is the whole of a Stop. */
function sendStop(pid: number): void {
  process.kill(pid, "SIGTERM");
}

function reason(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
