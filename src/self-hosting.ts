/**
 * Whether a Run's Target is the pipeline's own repository.
 *
 * Only there is the checkout a Stage stands in the pipeline itself, with tests
 * and fakes to exercise it through and spellings of its commands that name no
 * installed `ticket-runner` (`prompts.ts`). The pipeline decides this rather
 * than leaving a Stage to judge it from the files around it, and it decides it
 * once per Run, before the first Ticket.
 */

import type { Tracker } from "./ports/tracker.js";

/**
 * True where the Target's GitHub repository is `pipeline`, the pipeline's own
 * as its package names it, and false wherever either side cannot be read.
 *
 * GitHub reads `owner/name` without regard to case, so this does too. Nothing
 * here may stop a Run: a tracker that fails is a Target that is not the
 * pipeline's own, which gives its Stages the guidance that holds anywhere.
 */
export async function isPipelineRepository(
  tracker: Tracker,
  pipeline: string | undefined,
): Promise<boolean> {
  if (pipeline === undefined) return false;
  let target: string | undefined;
  try {
    target = await tracker.repository();
  } catch {
    return false;
  }
  return target !== undefined && target.toLowerCase() === pipeline.toLowerCase();
}
