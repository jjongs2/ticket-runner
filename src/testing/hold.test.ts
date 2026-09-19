import { describe, expect, it } from "vitest";
import type { StageName, StageRequest } from "../ports/agent-runner.js";
import { FakeAgentRunner, stageResult } from "./fakes.js";

/** Let everything that can settle settle, so a test can say what is still stuck. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function request(stage: StageName): StageRequest {
  return {
    stage,
    prompt: `the ${stage} prompt`,
    cwd: "/repo/.worktrees/ticket-2",
    model: "claude-opus-5",
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

    expect(finished).toBe(false);

    hold.release();
    await fix;

    expect(finished).toBe(true);
  });

  it("holds every run of that Stage, and says when they have all arrived", async () => {
    const runner = new FakeAgentRunner();
    const hold = runner.holds("implement");
    const both = Promise.all([runner.run(request("implement")), runner.run(request("implement"))]);

    await hold.started(2);
    hold.release();

    expect(await both).toHaveLength(2);
  });

  it("lets every other Stage through", async () => {
    const runner = new FakeAgentRunner();
    runner.holds("conflict");

    expect(await runner.run(request("verify"))).toEqual(stageResult());
  });

  it("lets a run that starts after the release straight through", async () => {
    const runner = new FakeAgentRunner();
    const hold = runner.holds("verify");
    hold.release();

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
    await settle();
    hold.release();

    expect((await verify).failure).toBe("turn-capped");
  });
});
