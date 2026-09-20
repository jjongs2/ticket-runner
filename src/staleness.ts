/**
 * What a Run and `init` say when something around them is from another Version,
 * and the one thing neither ever does about it.
 *
 * Two questions, both answered in one line and neither ever a refusal
 * (ADR-0007): is a newer Version published than the one running, and is the
 * Target's conventions document from another Version than the one reading it.
 * Nothing here is a gate. A pipeline that refused to work while a newer Version
 * existed would strand a Target on the night its maintainer was asleep, and
 * Target readiness already says what a Target is refused over: the document's
 * absence, never what it says.
 *
 * A number against a number, always. A development checkout runs a commit past
 * the Version it reports, so comparing anything finer would call every checkout
 * stale the moment its Version was cut.
 */

import { join } from "node:path";
import { CONVENTIONS_PATH, conventionsMark } from "./conventions.js";
import type { Tracker } from "./ports/tracker.js";
import { readTargetFile } from "./readiness.js";
import { isHigher, tagNumber, versionNumber } from "./version-number.js";

export interface StalenessQuestion {
  tracker: Tracker;
  /** The Version this copy is, as the CLI resolved it once and handed it down. */
  version: string;
  /**
   * The pipeline's own repository, as `owner/name`. Undefined where the package
   * names none, which asks nothing of the tracker at all: the lookup has no
   * repository to be about, and a Run is owed silence rather than a guess.
   */
  repository?: string | undefined;
}

/**
 * One line naming the Version that is out and the Version running, and nothing
 * at all where this copy is the latest, is ahead of it, or could not ask.
 *
 * What has been published as a GitHub Release is the question rather than the
 * highest tag, because a tag a workflow has not finished publishing is not a
 * Version anybody can install yet.
 */
export async function newerVersionLine({
  tracker,
  version,
  repository,
}: StalenessQuestion): Promise<string | undefined> {
  const own = versionNumber(version);
  if (own === undefined || repository === undefined) return undefined;

  const latest = await publishedVersionTag(tracker, repository);
  const published = latest === undefined ? undefined : tagNumber(latest);
  if (published === undefined || !isHigher(published, own)) return undefined;

  return `A newer Version is out: ${published}, and this is ${own} — upgrade with \`npm install -g "github:${repository}#semver:*"\`.`;
}

/**
 * Asking, where asking is possible, and nothing where it is not.
 *
 * The port answers with nothing when it could not reach GitHub, and this
 * catches what it could not answer at all — a `gh` that is not installed, a
 * tracker that threw. Both are the same answer here, because the one thing this
 * may not do is stop a Run.
 */
async function publishedVersionTag(
  tracker: Tracker,
  repository: string,
): Promise<string | undefined> {
  try {
    return await tracker.latestVersionTag(repository);
  } catch {
    return undefined;
  }
}

/**
 * The one warning a Run prints about the conventions document in `repoRoot`,
 * and nothing where the document is this Version's own.
 *
 * Worded for whichever side is behind, because only one of them can be put
 * right from here: a document an older pipeline left is `init`'s to rewrite,
 * and a document a newer one left is the install's to catch up with. A copy
 * carrying no mark at all is read as the older side, which is what every copy
 * written before the mark existed is.
 */
export function conventionsWarning(repoRoot: string, version: string): string | undefined {
  const own = versionNumber(version);
  if (own === undefined) return undefined;

  const document = readTargetFile(join(repoRoot, CONVENTIONS_PATH));
  const mark = conventionsMark(document);
  if (mark === own) return undefined;

  const subject = `This Target's \`${CONVENTIONS_PATH}\``;
  if (mark !== undefined && isHigher(mark, own)) {
    return `${subject} was left by ${mark}, and this Run is ${own} — upgrade \`agent-pipeline\`.`;
  }
  const left = mark === undefined ? "carries no Version" : `was left by ${mark}`;
  return `${subject} ${left}, and this Run is ${own} — run \`agent-pipeline init\` here to bring it up to date.`;
}
