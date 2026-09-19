/**
 * Let everything that can settle settle, so a test can say what is still stuck.
 *
 * Nothing in the fakes runs on a timer, so every await in a Ticket driven
 * through them resolves on the microtask queue — which one turn of the macrotask
 * queue drains to the end. Two turns are taken rather than one so the wait is
 * about what a Ticket is blocked on and not about how many awaits it took to
 * get there.
 */
export function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => setTimeout(resolve, 0), 0);
  });
}
