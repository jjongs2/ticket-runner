/**
 * A wait the caller can call off before it elapses.
 *
 * Called off rather than left to run out, because a pending timer keeps Node's
 * process alive: a Run that ended while one was still counting down would
 * hold the terminal until it did.
 */
export interface Timer {
  /** Resolves once the wait has elapsed, and never if it was called off first. */
  elapsed: Promise<void>;
  /** Call the wait off. Calling it off again, or after it elapsed, does nothing. */
  cancel(): void;
}

/** Start a wait of `ms` milliseconds. */
export type StartTimer = (ms: number) => Timer;

/** A wait on the real clock. */
export const startTimer: StartTimer = (ms) => {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return { elapsed, cancel: () => clearTimeout(handle) };
};
