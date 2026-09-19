/**
 * A point a fake stops at until the test lets it past.
 *
 * What a test needs to watch two Tickets at once: without it, everything the
 * fakes do finishes in the same turn of the event loop, so a Ticket is never
 * observably in the middle of anything and nothing can be said about what a
 * second Ticket does meanwhile. A hold parks the first Ticket exactly where the
 * test wants it — inside a Stage, inside a CI wait — and the test decides when
 * it carries on.
 *
 * Holding is per point, not per call: every run that reaches a held point waits,
 * and {@link release} lets all of them, and everything that arrives after, past.
 */
export class Hold {
  /** How many runs have reached the hold, released or not. */
  private arrivals = 0;

  private released = false;

  /** What resumes each run parked here. */
  private readonly parked: (() => void)[] = [];

  /** Tests waiting for arrivals, and how many each is waiting for. */
  private watching: { arrivals: number; resolve: () => void }[] = [];

  /** What the fake calls: park here unless the test has already let go. */
  async reached(): Promise<void> {
    this.arrivals += 1;
    // Before parking, so a test waiting on `started` is woken by the arrival
    // rather than by whatever the fake does next.
    this.wake();
    if (this.released) return;
    await new Promise<void>((resume) => this.parked.push(resume));
  }

  /**
   * Resolves once `arrivals` runs have reached the hold — which, while it is
   * held, is where they still are.
   */
  started(arrivals = 1): Promise<void> {
    if (this.arrivals >= arrivals) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.watching.push({ arrivals, resolve });
    });
  }

  /** Let everything parked here past, and hold nothing that arrives later. */
  release(): void {
    this.released = true;
    for (const resume of this.parked.splice(0)) resume();
  }

  private wake(): void {
    const woken = this.watching.filter((watcher) => watcher.arrivals <= this.arrivals);
    this.watching = this.watching.filter((watcher) => watcher.arrivals > this.arrivals);
    for (const watcher of woken) watcher.resolve();
  }
}
