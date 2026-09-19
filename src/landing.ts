/**
 * One Ticket's turn at the Landing: what it enters, gives up, and enters again.
 *
 * A turn rather than a bare pair of calls because a Ticket reaches the rebase
 * more than once — a fix Stage sends it back — and gives the Landing up on
 * paths that cannot know whether it ever got in. The turn remembers, so
 * entering twice and leaving what was never entered are both nothing.
 */
export interface LandingTurn {
  /** Wait for the Landing, and hold it until {@link leave}. */
  enter(): Promise<void>;
  /** Give the Landing up, so the Ticket that arrived next takes it. */
  leave(): void;
}

/**
 * The Landing: the stretch of a Ticket from its rebase to the pull of the Base
 * branch after its merge, which one Ticket is in at a time (ADR-0005).
 *
 * A Run has one and every Ticket it drives shares it, so the Base branch cannot
 * move between a Ticket's rebase and its merge: what CI graded is what lands.
 * Turns are taken in arrival order — the Ticket that reaches the rebase first
 * lands first, whatever its number — and a Ticket that leaves the stretch for a
 * fix Stage, a hand-off or a Release gives its turn up rather than holding every
 * other Ticket behind a session nobody is waiting on.
 *
 * With one Ticket at a time nothing here is ever contended: the first
 * {@link LandingTurn.enter} of a Run resolves on the spot, and the Run makes the
 * same calls in the same order it always did.
 */
export class Landing {
  /** Whether a Ticket is in the Landing right now. */
  private occupied = false;

  /** What resumes each waiting Ticket, in the order they arrived. */
  private readonly waiting: (() => void)[] = [];

  turn(): LandingTurn {
    // Whether this Ticket is the one inside, which only its own turn knows:
    // the Landing itself counts places, not Tickets.
    let inside = false;
    return {
      enter: async () => {
        if (inside) return;
        await this.take();
        inside = true;
      },
      leave: () => {
        if (!inside) return;
        inside = false;
        this.give();
      },
    };
  }

  private async take(): Promise<void> {
    if (!this.occupied) {
      this.occupied = true;
      return;
    }
    await new Promise<void>((resume) => this.waiting.push(resume));
  }

  private give(): void {
    // Handed straight to the Ticket that has waited longest rather than opened
    // to whoever asks next: a Landing left empty for a turn of the event loop
    // is one a Ticket arriving late could take ahead of the queue.
    const next = this.waiting.shift();
    if (next === undefined) {
      this.occupied = false;
      return;
    }
    next();
  }
}
