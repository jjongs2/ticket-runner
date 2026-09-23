import { describe, expect, it } from "vitest";
import type { StageName, StageRequest } from "../ports/agent-runner.js";
import { FakeAgentRunner, FakeTracker, stageResult } from "./fakes.js";
import { settle } from "./settle.js";

function request(stage: StageName): StageRequest {
  return {
    stage,
    prompt: `the ${stage} prompt`,
    cwd: "/repo/.worktrees/ticket-2",
    model: "claude-opus-5-5",
    effort: "high",
    maxTurns: 10,
    maxMinutes: 5,
    permissionMode: "auto",
    logDir: "/repo/.agent-pipeline/logs",
  };
}

describe("holding a Stage open", () => {
  it("keeps the Stage from coming back until the test releases it", async () => {
    const runner = new FakeAgentRunner();
    const hold = runner.holds("fix");
    let finished = false;

    const fix = runner.run(request("fix")).then(() => {
      finished = true;
    });
    await hold.started();
    await settle();

    expect(finished).toBe(false);

    hold.release();
    await fix;

    expect(finished).toBe(true);
  });

  it("holds every run of the Stage it was given, not just the first", async () => {
    const runner = new FakeAgentRunner();
    const hold = runner.holds("implement");
    const both = Promise.all([
      runner.run(request("implement")),
      runner.run(request("implement")),
    ]);
    await hold.started();
    await settle();

    expect(runner.stages()).toEqual(["implement", "implement"]);

    hold.release();

    expect(await both).toHaveLength(2);
  });

  it("lets every other Stage through", async () => {
    const runner = new FakeAgentRunner();
    runner.holds("conflict");

    expect(await runner.run(request("verify"))).toEqual(stageResult());
  });

  it("leaves what the Stage committed behind before it parks", async () => {
    const runner = new FakeAgentRunner();
    const committed: string[] = [];
    runner.leaves("implement", () => committed.push("feat(cli): do the thing (#2)"));
    const hold = runner.holds("implement");

    void runner.run(request("implement"));
    await hold.started();

    // The branch carries the work while the session is still open, as a real
    // one does: a Stage that committed and then ran long still committed.
    expect(committed).toHaveLength(1);
  });

  it("answers the result the test queued, once it is released", async () => {
    const runner = new FakeAgentRunner();
    runner.queue("verify", { ok: false, failure: "turn-capped" });
    const hold = runner.holds("verify");

    const verify = runner.run(request("verify"));
    await hold.started();
    hold.release();

    expect((await verify).failure).toBe("turn-capped");
  });
});

describe("holding a CI wait open", () => {
  it("keeps the wait from answering until the test releases it", async () => {
    const tracker = new FakeTracker();
    const hold = tracker.holdsCi();
    let answered = false;

    const wait = tracker.waitForCi(100, 1_000).then(() => {
      answered = true;
    });
    await hold.started();
    await settle();

    // Recorded on arrival, so a test can say the Ticket is inside the wait
    // rather than short of it.
    expect(tracker.ciWaits).toEqual([{ pullRequest: 100, timeoutMs: 1_000 }]);
    expect(answered).toBe(false);

    hold.release();
    await wait;

    expect(answered).toBe(true);
  });

  it("answers the outcome the test queued, once it is released", async () => {
    const tracker = new FakeTracker();
    tracker.queueCi({ state: "timed-out" });
    const hold = tracker.holdsCi();

    const wait = tracker.waitForCi(100, 1_000);
    await hold.started();
    hold.release();

    expect(await wait).toEqual({ state: "timed-out" });
  });
});
