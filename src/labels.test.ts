import { describe, expect, it } from "vitest";
import { ensureLabels } from "./labels.js";
import { FakeTracker } from "./testing/fakes.js";

const LABELS = {
  needsTriage: "needs-triage",
  needsInfo: "needs-info",
  readyForAgent: "ready-for-agent",
  readyForHuman: "ready-for-human",
  wontfix: "wontfix",
  inProgress: "in-progress",
};

describe("ensureLabels", () => {
  it("creates the whole triage vocabulary in a fresh repo", async () => {
    const tracker = new FakeTracker();

    const created = await ensureLabels(tracker, LABELS);

    expect(created.sort()).toEqual([
      "in-progress",
      "needs-info",
      "needs-triage",
      "ready-for-agent",
      "ready-for-human",
      "wontfix",
    ]);
    expect(tracker.createdLabels.every((label) => /^[0-9a-f]{6}$/.test(label.color))).toBe(true);
    expect(tracker.createdLabels.every((label) => label.description !== "")).toBe(true);
  });

  it("leaves labels that already exist untouched", async () => {
    const tracker = new FakeTracker();
    tracker.labels.add("wontfix");
    tracker.labels.add("ready-for-agent");

    const created = await ensureLabels(tracker, LABELS);

    expect(created).not.toContain("wontfix");
    expect(created).not.toContain("ready-for-agent");
    expect(tracker.calls).not.toContain("createLabel:wontfix");
  });

  it("creates nothing on a repo that is already set up", async () => {
    const tracker = new FakeTracker();
    for (const name of Object.values(LABELS)) tracker.labels.add(name);

    expect(await ensureLabels(tracker, LABELS)).toEqual([]);
    expect(tracker.calls).toEqual([]);
  });

  it("honours a repo that renamed a label in config", async () => {
    const tracker = new FakeTracker();

    await ensureLabels(tracker, { ...LABELS, inProgress: "agent-working" });

    expect(tracker.createdLabels.map((label) => label.name)).toContain("agent-working");
  });
});
