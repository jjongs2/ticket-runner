/**
 * The words the glossary once listed and no longer does, found where a text
 * still capitalises one mid-sentence, and every PR that prose should have
 * called a pull request.
 *
 * A dropped word is an ordinary word, so it is lowercase wherever English
 * would write any word in lowercase. A word that opens a sentence, a line or a
 * label keeps its capital, so only a word following a lowercase letter, a digit
 * or a comma and a space is read as mid-sentence: a check that cannot tell a
 * heading from prose would refuse the one and miss nothing in the other.
 */

const DROPPED =
  /(?<=[a-z0-9,;)] )(?:Executions?|Candidates?|Claims?|Base branch(?:es)?|Credentials?|Spend|Run Lock|Stage Mark|Session [Mm]arks?|Target Readiness|Progress|Guards?|Verify|Conflict|Verdicts?|Fix [Bb]udgets?|States?|Versions?)\b/g;

/** A PR that is neither a `PR #<n>` reference nor the set phrase release PR. */
const PR = /(?<!release )\bPRs?\b(?! #)/g;

/** Each mid-sentence capitalised dropped word in `text`, with the line it is on. */
export function capitalisedDroppedWords(text: string): string[] {
  return text
    .split("\n")
    .flatMap((line) => [...line.matchAll(DROPPED)].map((match) => `${match[0]}: ${line.trim()}`));
}

/** Each PR in `text` that prose should call a pull request, with the line it is on. */
export function bareAcronymPRs(text: string): string[] {
  return text
    .split("\n")
    .flatMap((line) => [...line.matchAll(PR)].map((match) => `${match[0]}: ${line.trim()}`));
}
