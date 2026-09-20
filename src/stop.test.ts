import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { StopSignal, listenForStop, stopLine } from "./stop.js";

/** A stand-in for the process, so a test raises SIGTERM without sending one. */
function source(): EventEmitter {
  return new EventEmitter();
}

describe("a Stop", () => {
  it("reaches a watcher registered before it, with the moment it arrived", () => {
    const stopping = new StopSignal();
    const arrived: string[] = [];
    stopping.watch(({ at }) => arrived.push(at));

    stopping.request(new Date("2026-09-20T22:07:13.000Z"));

    expect(arrived).toEqual(["2026-09-20T22:07:13.000Z"]);
  });

  it("reaches a watcher registered after it, at once", () => {
    const stopping = new StopSignal();
    stopping.request(new Date("2026-09-20T22:07:13.000Z"));
    const arrived: string[] = [];

    stopping.watch(({ at }) => arrived.push(at));

    expect(arrived).toEqual(["2026-09-20T22:07:13.000Z"]);
  });

  it("arrives once, however many times it is asked for", () => {
    const stopping = new StopSignal();
    const arrived: string[] = [];
    stopping.watch(({ at }) => arrived.push(at));

    stopping.request(new Date("2026-09-20T22:07:13.000Z"));
    stopping.request(new Date("2026-09-20T22:08:00.000Z"));
    stopping.request(new Date("2026-09-20T22:09:00.000Z"));

    // The first moment, because that is when the Run was asked to stop.
    expect(arrived).toEqual(["2026-09-20T22:07:13.000Z"]);
  });
});

describe("listening for SIGTERM", () => {
  it("turns the signal into a Stop", () => {
    const signals = source();
    const stopping = new StopSignal();
    const arrived: string[] = [];
    stopping.watch(({ at }) => arrived.push(at));
    listenForStop(stopping, signals);

    signals.emit("SIGTERM");

    expect(arrived).toHaveLength(1);
  });

  it("takes a second SIGTERM as nothing at all", () => {
    const signals = source();
    const stopping = new StopSignal();
    let arrivals = 0;
    stopping.watch(() => {
      arrivals += 1;
    });
    listenForStop(stopping, signals);

    signals.emit("SIGTERM");
    signals.emit("SIGTERM");

    expect(arrivals).toBe(1);
  });

  it("stops listening when the Run is over, so the process can exit", () => {
    const signals = source();
    const stopping = new StopSignal();
    let arrivals = 0;
    stopping.watch(() => {
      arrivals += 1;
    });

    listenForStop(stopping, signals)();

    expect(signals.listenerCount("SIGTERM")).toBe(0);
    signals.emit("SIGTERM");
    expect(arrivals).toBe(0);
  });
});

describe("the line a Run logs", () => {
  it("leads with the Tickets its Lanes hold", () => {
    expect(stopLine([4, 9])).toBe("#4 #9 finish the Run · stopped");
  });

  it("says so when no Lane is busy", () => {
    expect(stopLine([])).toBe("no Lane busy · stopped");
  });
});
