import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";
import type { LockHolder } from "./ports/workspace.js";
import { type StopRequest, StopSignal, listenForStop, requestStop, stopLine } from "./stop.js";
import { ANOTHER_HOST, FakeWorkspace, THIS_HOST } from "./testing/fakes.js";

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
    expect(stopLine([4, 9])).toBe("#4 #9 left to finish · stopped");
  });

  it("says so when no Lane is busy", () => {
    expect(stopLine([])).toBe("nothing left to finish · stopped");
  });
});

describe("asking a Run to stop", () => {
  let workspace: FakeWorkspace;

  beforeEach(() => {
    workspace = new FakeWorkspace();
  });

  /** The Run lock as a Run on this Host that is still running leaves it. */
  function lock(overrides: Partial<LockHolder> = {}): void {
    workspace.lock = {
      holder: {
        host: THIS_HOST,
        pid: 4321,
        command: "ticket-runner run",
        runId: "2026-09-17T09-00-00-000",
        startedAt: "2026-09-17T09:00:00.000Z",
        ...overrides,
      },
      running: true,
    };
  }

  /** The Run the lock names is no longer running, whatever the reason. */
  function abandon(): void {
    if (workspace.lock !== undefined) workspace.lock.running = false;
  }

  /** One `ticket-runner stop`, with the lock and the signal faked. */
  async function stop(options: Partial<StopRequest> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const signalled: number[] = [];
    const code = await requestStop({
      workspace,
      send: (pid) => signalled.push(pid),
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      ...options,
    });
    return { code, signalled, lines: out, out: out.join("\n"), err: err.join("\n") };
  }

  it("sends SIGTERM to the Run the lock names, and says what it will finish", async () => {
    lock();

    const { code, signalled, lines } = await stop();

    expect(signalled).toEqual([4321]);
    expect(code).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("`ticket-runner run`");
    expect(lines[0]).toContain("pid 4321");
    expect(lines[0]).toContain("2026-09-17T09-00-00-000");
  });

  it("names Ctrl+C as the way to stop at once, and what that costs", async () => {
    lock();

    const { lines } = await stop();

    expect(lines[1]).toContain("Ctrl+C");
    expect(lines[1]).toContain("strand");
  });

  it("says the same thing twice, because the Run ignores the second signal", async () => {
    lock();

    const first = await stop();
    const second = await stop();

    expect(second.out).toBe(first.out);
    expect(second.code).toBe(0);
    expect(second.signalled).toEqual([4321]);
  });

  it("refuses when no Run holds the lock, and sends nothing", async () => {
    const { code, signalled, err, out } = await stop();

    expect(code).toBe(2);
    expect(signalled).toEqual([]);
    expect(err).toContain("No Run to stop");
    expect(err).toContain("`ticket-runner/lock` branch");
    expect(out).toBe("");
  });

  it("refuses a lock whose process is gone, and leaves the lock where it is", async () => {
    lock();
    abandon();

    const { code, signalled, err } = await stop();

    expect(code).toBe(2);
    expect(signalled).toEqual([]);
    expect(err).toContain("No Run to stop");
    expect(workspace.lock).toBeDefined();
  });

  it("names a Run on another Host and sends nothing, since only that Host can", async () => {
    lock({ host: ANOTHER_HOST });

    const { code, signalled, err, out } = await stop();

    expect(code).toBe(2);
    expect(signalled).toEqual([]);
    expect(out).toBe("");
    expect(err).toContain("`ticket-runner run`");
    expect(err).toContain("run 2026-09-17T09-00-00-000");
    expect(err).toContain("the cloud Host of session `session_01other`");
    expect(err).toContain("started 2026-09-17T09:00:00.000Z");
    expect(err).toContain("Nothing was sent.");
  });

  it("names a Run on another Host whatever this Host's process table says", async () => {
    // Nothing here can see another Host's processes, so a pid that is gone
    // here says nothing about the Run there.
    lock({ host: ANOTHER_HOST });
    abandon();

    const { code, signalled, err } = await stop();

    expect(code).toBe(2);
    expect(signalled).toEqual([]);
    expect(err).toContain("holds the Run lock from the cloud Host");
  });

  it("names a Run a Run on the other Host sees as its own", async () => {
    // The same lock, read from the cloud Host that holds it: its own Run.
    lock({ host: ANOTHER_HOST });

    const { code, signalled } = await stop({ workspace: workspace.anotherHost() });

    expect(code).toBe(0);
    expect(signalled).toEqual([4321]);
  });

  it.each(["ticket-runner run 12 13", "ticket-runner run --lanes 3 12"])(
    "asks a narrowed Run to stop like any other: `%s`",
    async (command) => {
      lock({ command });

      const { code, signalled, out } = await stop();

      expect(code).toBe(0);
      expect(signalled).toEqual([4321]);
      expect(out).toContain(`\`${command}\``);
    },
  );

  it("reports a signal it could not deliver, and claims nothing was stopped", async () => {
    lock();

    const { code, err, out } = await stop({
      send: () => {
        throw new Error("kill ESRCH");
      },
    });

    expect(code).toBe(2);
    expect(err).toContain("ESRCH");
    expect(out).toBe("");
  });
});
