import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";
import type { LockHolder } from "./ports/workspace.js";
import { type StopRequest, StopSignal, listenForStop, requestStop, stopLine } from "./stop.js";
import { FakeWorkspace } from "./testing/fakes.js";

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
  const repoRoot = "/repo";
  let workspace: FakeWorkspace;

  beforeEach(() => {
    workspace = new FakeWorkspace();
  });

  /** The Run lock as a Run that is still running leaves it. */
  function lock(overrides: Partial<LockHolder> = {}): void {
    workspace.lock = {
      holder: {
        pid: 4321,
        command: "agent-pipeline run",
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

  /** One `agent-pipeline stop`, with the lock and the signal faked. */
  async function stop(options: Partial<StopRequest> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const signalled: number[] = [];
    const code = await requestStop({
      repoRoot,
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
    expect(lines[0]).toContain("`agent-pipeline run`");
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

  it("leaves a `ticket <n>` Run alone, because it ends with its Ticket anyway", async () => {
    lock({ command: "agent-pipeline ticket 5" });

    const { code, signalled, err } = await stop();

    expect(code).toBe(2);
    expect(signalled).toEqual([]);
    expect(err).toContain("`agent-pipeline ticket 5`");
    expect(err).toContain("Ticket");
  });

  it("asks a holder whose command line names no command, rather than passing it over", async () => {
    // What a lock file with no command line at all reads back as.
    lock({ command: "agent-pipeline" });

    const { code, signalled } = await stop();

    expect(signalled).toEqual([4321]);
    expect(code).toBe(0);
  });

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
