import type { Labels } from "./config.js";
import type { LabelSpec, Tracker } from "./ports/tracker.js";

/**
 * The colour and meaning each triage role is created with. The names come from
 * config, so a repo that calls them something else still gets them created.
 */
const LABEL_SPECS: Record<keyof Labels, Omit<LabelSpec, "name">> = {
  needsTriage: { color: "fbca04", description: "Maintainer needs to evaluate this issue" },
  needsInfo: { color: "d876e3", description: "Waiting on reporter for more information" },
  readyForAgent: { color: "0e8a16", description: "Fully specified, ready for an AFK agent" },
  readyForHuman: { color: "d93f0b", description: "Requires human implementation" },
  wontfix: { color: "cfd3d7", description: "Will not be actioned" },
  inProgress: { color: "1d76db", description: "Claimed by an agent-pipeline Run" },
};

/**
 * Create whatever the triage state machine needs and the Target does not have
 * yet, so a fresh Target works without manual label setup.
 *
 * `agent-pipeline init` is the only caller: a Run that finds a label missing
 * refuses the Target rather than creating it, so setup lives in one command.
 *
 * Returns the names it created; labels that already exist are left untouched,
 * colour and description included.
 */
export async function ensureLabels(tracker: Tracker, labels: Labels): Promise<string[]> {
  const existing = new Set(await tracker.listLabels());
  const created: string[] = [];

  for (const [role, spec] of Object.entries(LABEL_SPECS) as [
    keyof Labels,
    Omit<LabelSpec, "name">,
  ][]) {
    const name = labels[role];
    if (existing.has(name)) continue;
    await tracker.createLabel({ name, ...spec });
    created.push(name);
  }

  return created;
}
