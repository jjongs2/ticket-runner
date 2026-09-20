/**
 * A Stop, and how a Run comes to hear about one.
 *
 * SIGTERM is the whole of what a Stop is on the wire (ADR-0006): no file beside
 * the Run lock, and no meaning for Ctrl+C. What a Run then does with it —
 * finish the Tickets its Lanes hold and claim nothing more — is the Run's own
 * business; this is the part that turns a signal into something a test can
 * raise without a process to send one to.
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
