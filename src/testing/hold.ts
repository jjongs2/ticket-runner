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
 *
 * Scaffolding the fakes are built from rather than a word the pipeline uses, so
 * it is not in `CONTEXT.md`: nothing a Run does is ever held.
 */
export class Hold {
  /** How many runs have reached the hold, parked or waved through. */
  private arrivals = 0;

  private released = false;

  /** What resumes each run parked here. */
  private readonly parked: (() => void)[] = [];

  /** Tests waiting to be told that a run has reached the hold. */
  private readonly watching: (() => void)[] = [];

  /** What the fake calls: park here unless the test has already let go. */
  async reached(): Promise<void> {
    this.arrivals += 1;
    // Woken before this run parks, so a test waiting on `started` is told by
    // the arrival rather than by whatever the fake does next.
    for (const watcher of this.watching.splice(0)) watcher();
    if (this.released) return;
    await new Promise<void>((resume) => this.parked.push(resume));
  }

  /**
   * Resolves once a run has reached the hold — which, while it is held, is
   * where that run still is.
   */
  started(): Promise<void> {
    if (this.arrivals > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.watching.push(resolve);
    });
  }

  /** Let everything parked here past, and hold nothing that arrives later. */
  release(): void {
    this.released = true;
    for (const resume of this.parked.splice(0)) resume();
  }
}
