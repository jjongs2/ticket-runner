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
 * The Target's GitHub repository as `owner/name`, read once per Run, or
 * nothing wherever GitHub could not name it. Nothing here may stop a Run: a
 * tracker that fails is a Target nobody could name.
 */
export async function targetRepository(
  tracker: Pick<Tracker, "repository">,
): Promise<string | undefined> {
  try {
    return await tracker.repository();
  } catch {
    return undefined;
  }
}

/**
 * True where the Target's GitHub repository, `target`, is `pipeline`, the
 * pipeline's own as its package names it, and false wherever either side could
 * not be read, which gives the Target's Stages the guidance that holds anywhere.
 *
 * GitHub reads `owner/name` without regard to case, so this does too.
 */
export function isPipelineRepository(
  target: string | undefined,
  pipeline: string | undefined,
): boolean {
  return (
    pipeline !== undefined && target !== undefined && target.toLowerCase() === pipeline.toLowerCase()
  );
}
