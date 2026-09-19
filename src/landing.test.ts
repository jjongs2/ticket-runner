import { describe, expect, it } from "vitest";
import { Landing } from "./landing.js";
import { settle } from "./testing/settle.js";

/** A Ticket asking for the Landing, which records its name once it is in. */
function arrive(landing: Landing, name: string, entered: string[]) {
  const turn = landing.turn();
  const inside = turn.enter().then(() => {
    entered.push(name);
  });
  return { turn, inside };
}

describe("the Landing", () => {
  it("lets the first Ticket in without waiting", async () => {
    const entered: string[] = [];
    arrive(new Landing(), "first", entered);
    await settle();

    expect(entered).toEqual(["first"]);
  });

  it("holds every other Ticket out until the one inside leaves", async () => {
    const landing = new Landing();
    const entered: string[] = [];
    const first = arrive(landing, "first", entered);
    await settle();
    arrive(landing, "second", entered);
    await settle();

    expect(entered).toEqual(["first"]);

    first.turn.leave();
    await settle();

    expect(entered).toEqual(["first", "second"]);
  });

  it("takes Tickets in the order they arrived", async () => {
    const landing = new Landing();
    const entered: string[] = [];
    const first = arrive(landing, "first", entered);
    await settle();
    // Queued in this order and in no other: the numbers the Tickets carry, and
    // the order their turns were made in, say nothing about who lands next.
    const second = arrive(landing, "second", entered);
    const third = arrive(landing, "third", entered);
    await settle();

    first.turn.leave();
    await settle();
    second.turn.leave();
    await settle();
    third.turn.leave();

    expect(entered).toEqual(["first", "second", "third"]);
  });

  it("sends a Ticket that left back to the end of the queue", async () => {
    const landing = new Landing();
    const entered: string[] = [];
    const first = arrive(landing, "first", entered);
    await settle();
    const second = arrive(landing, "second", entered);
    await settle();

    // What a fix Stage does: out of the Landing, then back to the rebase.
    first.turn.leave();
    const again = first.turn.enter().then(() => entered.push("first again"));
    await settle();

    expect(entered).toEqual(["first", "second"]);

    second.turn.leave();
    await again;

    expect(entered).toEqual(["first", "second", "first again"]);
  });

  it("does nothing when a Ticket that never entered leaves", async () => {
    const landing = new Landing();
    const entered: string[] = [];
    // The hand-off path of a Ticket that failed before its rebase: it gives the
    // Landing up without ever having been in it, and takes nobody's turn away.
    landing.turn().leave();
    arrive(landing, "first", entered);
    arrive(landing, "second", entered);
    await settle();

    expect(entered).toEqual(["first"]);
  });

  it("does nothing when a Ticket already inside enters again", async () => {
    const landing = new Landing();
    const entered: string[] = [];
    const first = arrive(landing, "first", entered);
    await settle();
    await first.turn.enter();
    arrive(landing, "second", entered);
    await settle();

    expect(entered).toEqual(["first"]);

    // One leave is still all the Ticket owes: the second enter took nothing.
    first.turn.leave();
    await settle();

    expect(entered).toEqual(["first", "second"]);
  });
});
