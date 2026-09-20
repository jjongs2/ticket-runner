/**
 * The Version plumbing of this repository, as its two workflows call it.
 *
 * `.github/workflows/version-pr.yml` runs `check` on every pull request and
 * `.github/workflows/version-tag.yml` runs `number` and `notes` on every push
 * to `main`. All this does is read — two package files, the tags, the changelog
 * — and hand what it read to the pure functions in `src/version-pr.ts`, which
 * is where the judgement is and where the tests are. Nothing here is published:
 * `scripts/` is outside the package's `files`, so an installed pipeline carries
 * none of it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { versionNotes, versionPrRefusals } from "../src/version-pr.js";

/** The branch a pull request is judged against; the workflow passes it. */
const BASE_REF = process.env.BASE_REF ?? "main";

const [command] = process.argv.slice(2);
switch (command) {
  case "number":
    console.log(packageNumber(read("package.json")));
    break;
  case "notes":
    printNotes();
    break;
  case "check":
    printRefusals();
    break;
  default:
    fail(`Usage: version.ts number|notes|check (given \`${command ?? ""}\`)`);
}

/**
 * Every reason this pull request may not merge, one per line, and exit code 1
 * with any — which is how the check fails the pull request.
 */
function printRefusals(): void {
  const number = packageNumber(read("package.json"));
  const refusals = versionPrRefusals({
    number,
    baseNumber: packageNumber(baseFile("package.json")),
    lockNumber: lockNumber(number),
    tags: git(["tag", "--list"]).split("\n").filter(Boolean),
    changelog: readIfPresent("CHANGELOG.md") ?? "",
  });
  if (refusals.length === 0) {
    console.log(`\`${number}\` may merge.`);
    return;
  }
  for (const refusal of refusals) console.error(refusal);
  process.exitCode = 1;
}

/**
 * The Version notes this checkout's number has, and nothing at all where the
 * changelog has no section for it: the tag workflow reads empty output as its
 * cue to publish GitHub's generated notes instead.
 */
function printNotes(): void {
  const notes = versionNotes(readIfPresent("CHANGELOG.md") ?? "", packageNumber(read("package.json")));
  if (notes !== undefined) console.log(notes);
}

/** The `version` of a `package.json`, whichever revision it was read from. */
function packageNumber(text: string): string {
  const number: unknown = JSON.parse(text).version;
  if (typeof number !== "string" || number === "") fail("`package.json` carries no `version`.");
  return number;
}

/**
 * What the lock file says this package is. npm keeps the number in two places,
 * so the one reported is whichever disagrees with `package.json`: a lock file
 * half raised is as wrong as one not raised at all.
 */
function lockNumber(number: string): string {
  const lock = JSON.parse(read("package-lock.json"));
  const numbers: unknown[] = [lock.version, lock.packages?.[""]?.version];
  const disagreeing = numbers.find((found) => found !== number);
  return typeof disagreeing === "string" ? disagreeing : number;
}

/** A file of this checkout, which every command needs to exist. */
function read(path: string): string {
  const text = readIfPresent(path);
  if (text === undefined) fail(`This checkout has no \`${path}\`.`);
  return text;
}

/** A file of this checkout, or undefined where it has none. */
function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * A file as the base branch has it. The checkout fetches every branch, so the
 * remote-tracking ref is the branch the pull request will merge into; a read
 * that fails is reported rather than guessed at, because a check that judged a
 * pull request against a number it invented would refuse them all.
 */
function baseFile(path: string): string {
  try {
    return git(["show", `origin/${BASE_REF}:${path}`]);
  } catch {
    return fail(`\`${path}\` could not be read on \`origin/${BASE_REF}\`.`);
  }
}

/** What git said, trimmed. Throws where git failed. */
function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Say what went wrong and stop: nothing here judges on a guess. */
function fail(reason: string): never {
  console.error(reason);
  process.exit(2);
}
