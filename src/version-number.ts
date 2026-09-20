/**
 * Arithmetic on Version numbers: which of two is higher, and which number a tag
 * or a Version string carries.
 *
 * Three readers share it and would otherwise each have a comparison of their
 * own: the check on a Version PR, the notice a Run prints when a newer Version
 * has been published, and the mark a Target's conventions document bears
 * (ADR-0007). Nothing here reads a file or asks GitHub — a number against a
 * number — so the one thing every Version question turns on is proved once.
 */

/** A number on its own: the three parts every Version tag is cut at. */
const NUMBER = /^\d+\.\d+\.\d+$/;

/**
 * The number a Version string reports, without the commit a development
 * checkout adds: `0.4.0+331d79c.dirty` is `0.4.0`.
 *
 * Undefined where the string carries no number at all, which is what a copy
 * with no package to read calls itself. Comparing by number is what lets a
 * checkout running a commit past the latest Version count as current rather
 * than as stale: between two Versions the commit says nothing either way.
 */
export function versionNumber(version: string): string | undefined {
  const [number = ""] = version.split("+");
  return NUMBER.test(number) ? number : undefined;
}

/** The number a Version tag names: `v0.4.0` is `0.4.0`, and nothing else is one. */
export function tagNumber(tag: string): string | undefined {
  return tag.startsWith("v") ? versionNumber(tag.slice(1)) : undefined;
}

/** A Version tag, in both halves its readers want: `v0.4.0` and `0.4.0`. */
export interface VersionTag {
  tag: string;
  number: string;
}

/**
 * The highest Version among tags shaped `v<x.y.z>`, and undefined where there
 * is no Version tag at all — the first Version, which nothing can be measured
 * against.
 *
 * Every other tag is ignored rather than refused: a repository is free to tag
 * whatever else it likes, and only the Versions say what has been cut. The tag
 * comes back beside its number because a message names the tag as it was cut
 * and the comparison is on the number.
 */
export function highestVersion(tags: string[]): VersionTag | undefined {
  return tags.reduce<VersionTag | undefined>((highest, tag) => {
    const number = tagNumber(tag);
    if (number === undefined) return highest;
    return highest === undefined || isHigher(number, highest.number) ? { tag, number } : highest;
  }, undefined);
}

/** Whether `number` is above `other`, part by part as numbers: `0.10.0` is above `0.9.0`. */
export function isHigher(number: string, other: string): boolean {
  const parts = number.split(".").map(Number);
  const others = other.split(".").map(Number);
  for (const [index, part] of parts.entries()) {
    const against = others[index] ?? 0;
    if (part !== against) return part > against;
  }
  return false;
}
