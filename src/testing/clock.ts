import type { StartTimer } from "../timer.js";
import { settle } from "./settle.js";

/** One wait started on a {@link FakeClock}: when it elapses, and what that wakes. */
interface Wait {
  at: number;
  elapse: () => void;
}

/**
 * A clock that moves only when the test moves it.
 *
 * What a test needs to say what a Run does after five minutes without waiting
 * five minutes: every wait the Run starts on it elapses only once
 * {@link advance} has carried the clock past its moment.
 *
 * Scaffolding the tests are built from rather than a word the pipeline uses, so
 * it is not in `GLOSSARY.md`.
 */
export class FakeClock {
  /** Milliseconds since the clock was made. */
  now = 0;

  /** Every wait started and neither elapsed nor called off yet. */
  private readonly waiting = new Set<Wait>();

  /** How many waits have been started on this clock, called off or not. */
  started = 0;

  /** What the code under test is handed in place of the real clock. */
  readonly start: StartTimer = (ms) => {
    this.started += 1;
    let wait: Wait | undefined;
    const elapsed = new Promise<void>((resolve) => {
      wait = { at: this.now + ms, elapse: resolve };
    });
    const started = wait as Wait;
    this.waiting.add(started);
    return { elapsed, cancel: () => this.waiting.delete(started) };
  };

  /** How many waits are still counting down. */
  get pending(): number {
    return this.waiting.size;
  }

  /**
   * Carry the clock `ms` on, elapse every wait whose moment it passed, earliest
   * first, and let what each one woke settle before the next.
   */
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.waiting]
        .filter((wait) => wait.at <= until)
        .sort((first, second) => first.at - second.at)[0];
      if (due === undefined) break;
      this.now = due.at;
      this.waiting.delete(due);
      due.elapse();
      await settle();
    }
    this.now = until;
    await settle();
  }
}
