/**
 * What a Version PR has to get right, and what its merge publishes.
 *
 * A Version is cut by merging a Version PR: the number in `package.json` goes
 * up, `CHANGELOG.md` gains that Version's section, and the push to `main`
 * creates the tag and a GitHub Release whose body is that section (ADR-0007).
 * The check on the pull request and the workflow that publishes read the same
 * changelog, so they are written together here: a check that found a section
 * the extraction then missed would tag a Version and publish nothing, which is
 * the one failure neither half can see on its own.
 *
 * Both functions are pure. Everything they judge — the two numbers, the tags,
 * the changelog — is read by the workflow that calls them, because a check that
 * ran git itself could not be tested without one.
 */

import { highestTag, isHigher, tagNumber } from "./version-number.js";

/**
 * The one heading every Version's notes carry, whatever they group the rest by.
 * What a Target or its human has to do after upgrading is the thing a reader of
 * this tool cannot get anywhere else, so its absence is a refusal.
 */
const AFTER_UPGRADING = "### After upgrading";

/** A pull request, in the five things a Version PR is judged by. */
export interface VersionPr {
  /** The number in `package.json` on the head. */
  number: string;
  /** The number in `package.json` on the base branch. */
  baseNumber: string;
  /** The number in the lock file on the head. */
  lockNumber: string;
  /** Every tag the repository has, Version tags and anything else. */
  tags: string[];
  /** `CHANGELOG.md` on the head, empty where the head has none. */
  changelog: string;
}

/**
 * Every reason this pull request may not merge, in the order a reader meets
 * them, and empty where it may.
 *
 * All of them at once rather than the first: the human fixing a Version PR is
 * running the check through a pull request, and one refusal per push would cost
 * a round trip each.
 *
 * A number equal to the base branch's is not a Version PR at all, so nothing
 * else is looked at. That is every Ticket's pull request, which passes this
 * check without being written for it.
 */
export function versionPrRefusals(pr: VersionPr): string[] {
  if (pr.number === pr.baseNumber) return [];

  const refusals: string[] = [];
  const highest = highestTag(pr.tags);
  const highestNumber = highest === undefined ? undefined : tagNumber(highest);
  if (highest !== undefined && highestNumber !== undefined && !isHigher(pr.number, highestNumber)) {
    refusals.push(`\`${pr.number}\` is not higher than every Version tag; \`${highest}\` exists.`);
  }
  if (pr.lockNumber !== pr.number) {
    refusals.push(`\`package-lock.json\` says \`${pr.lockNumber}\`, not \`${pr.number}\`.`);
  }

  const notes = versionNotes(pr.changelog, pr.number);
  if (notes === undefined) {
    refusals.push(`\`CHANGELOG.md\` has no \`## ${pr.number}\` section.`);
  } else if (!notes.includes(AFTER_UPGRADING)) {
    refusals.push(
      `The \`${pr.number}\` section of \`CHANGELOG.md\` has no \`${AFTER_UPGRADING}\` heading.`,
    );
  }
  return refusals;
}

/**
 * The Version notes for `number`: its section of the changelog, without the
 * `## ` heading the number is written in, and undefined where the changelog has
 * no section for it.
 *
 * Undefined is not a failure. The tag workflow falls back to GitHub's generated
 * notes, because a Version that reached `main` is cut either way.
 */
export function versionNotes(changelog: string, number: string): string | undefined {
  return sections(changelog).get(number)?.trim();
}

/**
 * Every section of the changelog, by the number its heading names. A `## `
 * heading is the boundary; the number is its first word, so a heading that lost
 * its date is still read. The newest of two sections for one number wins, since
 * the file is newest first.
 */
function sections(changelog: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const text of changelog.split(/^## /m).slice(1)) {
    const [heading = "", ...body] = text.split("\n");
    const number = heading.trim().split(/\s/)[0] ?? "";
    if (!found.has(number)) found.set(number, body.join("\n"));
  }
  return found;
}
