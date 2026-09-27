import { readFileSync } from "node:fs";

/**
 * The Operator's instructions, as a project skill a Target carries (ADR-0008).
 *
 * A cloud session carries nothing over from the human's account, only the
 * repository it was opened on, so the one place an Operator can learn what to
 * do is the Target itself: `init` writes the skill there, and Target readiness
 * asks for it on every Host.
 *
 * Its text is a shape like every other the pipeline writes, so it lives with
 * them in `docs/templates/`, and it is read from there rather than copied into
 * this module: the package carries that one file for this. The text names no
 * Version. The Operator reads the one to install off the conventions document's
 * mark, so a Target is never rewritten for a Version that changed nothing here.
 */

/** Where the skill goes in a Target, relative to the Target's root. */
export const OPERATOR_SKILL_PATH = ".claude/skills/ticket-runner/SKILL.md";

/** The skill as {@link OPERATOR_SKILL_PATH} must contain it. */
export function operatorSkill(): string {
  return readFileSync(new URL("../docs/templates/operator-skill.md", import.meta.url), "utf8");
}
