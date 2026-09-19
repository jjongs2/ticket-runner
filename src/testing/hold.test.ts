import { describe, expect, it } from "vitest";
import { Hold } from "./hold.js";
import { settle } from "./settle.js";

/** A run reaching the hold, which records that it got past it. */
function reach(hold: Hold, name: string, past: string[]) {
  return hold.reached().then(() => {
    past.push(name);
  });
}

describe("a hold", () => {
  it("parks what reaches it until the test releases it", async () => {
    const hold = new Hold();
    const past: string[] = [];
    const first = reach(hold, "first", past);
    await hold.started();
    await settle();

    expect(past).toEqual([]);

    hold.release();
    await first;

    expect(past).toEqual(["first"]);
  });

  it("parks every run that reaches it, and lets them all past at once", async () => {
    const hold = new Hold();
    const past: string[] = [];
    const both = Promise.all([reach(hold, "first", past), reach(hold, "second", past)]);
    await hold.started();
    await settle();

    expect(past).toEqual([]);

    hold.release();
    await both;

    expect(past).toEqual(["first", "second"]);
  });

  it("says a run has started as soon as one reaches it", async () => {
    const hold = new Hold();
    let told = false;
    const started = hold.started().then(() => {
      told = true;
    });
    await settle();

    expect(told).toBe(false);

    void hold.reached();
    await started;

    expect(told).toBe(true);
  });

  it("tells a test that asks after the fact, rather than waiting for a second run", async () => {
    const hold = new Hold();
    void hold.reached();

    await expect(hold.started()).resolves.toBeUndefined();
  });

  it("waves through what reaches it after the release", async () => {
    const hold = new Hold();
    hold.release();

    await expect(hold.reached()).resolves.toBeUndefined();
  });
});
