import type { ListedCriterion } from "./acceptance-criteria.js";
import { NOTES_LIST_SCHEMA } from "./note-schema.js";
import { z } from "zod";

/**
 * The structured result of the verify Stage: one status per Acceptance
 * Criterion, answered by the number the pipeline listed it under, with the
 * evidence the session gathered for it, and the defects of the branch it found
 * beside them.
 */
const answerSchema = z.object({
  number: z.number().int(),
  status: z.enum(["met", "unmet", "unverifiable", "ci"]),
  evidence: z.string(),
});

const defectSchema = z.object({
  summary: z.string(),
  evidence: z.string(),
});

const answeredSchema = z.object({
  criteria: z.array(answerSchema).min(1),
  defects: z.array(defectSchema).default([]),
  /** The agent's own opinion. The pipeline recomputes it; see {@link passes}. */
  pass: z.boolean(),
});

/** The verdict as the Stage answered it, before its numbers are checked against the list. */
export type AnsweredVerdict = z.infer<typeof answeredSchema>;
export type CriterionStatus = z.infer<typeof answerSchema>["status"];

/**
 * A defect this branch introduced, or one in code it added, which the verify
 * Stage reports beside the criteria rather than as a Note. It fails the
 * verdict as an `unmet` criterion does.
 */
export type Defect = z.infer<typeof defectSchema>;

/** One listed criterion and what the verdict made of it. */
export interface GradedCriterion extends ListedCriterion {
  status: CriterionStatus;
  evidence: string;
}

/**
 * A verdict whose numbers are exactly the listed ones: every criterion carries
 * the line the pipeline listed it as, so whatever shows a criterion shows the
 * Ticket's words and never the Stage's copy of them.
 */
export interface Verdict {
  criteria: GradedCriterion[];
  defects: Defect[];
}

/**
 * How a verdict's numbers missed the list, which means it has not graded the
 * Ticket: a number listed and not answered, one answered and not listed, one
 * answered more than once.
 */
export interface Misnumbered {
  missing: number[];
  unlisted: number[];
  repeated: number[];
}

/** The `defects` list as the verify Stage reads it. */
const DEFECTS_LIST_SCHEMA = {
  type: "array",
  description:
    "Defects this branch introduced, or in code it added, beside the criteria. Empty when you found none.",
  items: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One short sentence naming the defect." },
      evidence: {
        type: "string",
        description:
          "Where it sits, what you ran or read, what you expected, what came back, and the counterexample. It proposes no fix",
      },
    },
    required: ["summary", "evidence"],
    additionalProperties: false,
  },
} as const;

/**
 * The `--json-schema` the verify Stage is invoked with: the verdict, and the
 * Notes channel beside it.
 *
 * The `notes` list has to be declared here even though {@link parseVerdict}
 * strips it and the Notes parser reads it off any object at all, because this
 * schema closes its top level to additional properties.
 *
 * Neither `notes` nor `defects` is required, where the criteria and the flag
 * are. The verdict is the Stage's product and a session that graded nothing has
 * done none of its job, so every required key here is a way for a Ticket to
 * lose its verdict. A verdict that leaves a list out is one from a session that
 * found nothing to put in it.
 */
export const VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: {
            type: "integer",
            description: "The criterion's number in the list the prompt gives",
          },
          status: {
            type: "string",
            enum: ["met", "unmet", "unverifiable", "ci"],
            description:
              "`ci` only for a criterion that asks for nothing but CI, or some commands, to pass, left to a workflow that runs on this pull request",
          },
          evidence: {
            type: "string",
            description: "What you ran or read, and what it showed. It proposes no fix",
          },
        },
        required: ["number", "status", "evidence"],
        additionalProperties: false,
      },
    },
    defects: DEFECTS_LIST_SCHEMA,
    pass: { type: "boolean" },
    notes: {
      ...NOTES_LIST_SCHEMA,
      description:
        "Defects that belong to another Ticket, or to no Ticket yet. A defect this branch made goes in `defects`, not here. Empty when you found none, which is the ordinary case.",
    },
  },
  required: ["criteria", "pass"],
  additionalProperties: false,
} as const;

/** Parse the verify Stage's structured output. Throws when it is unusable. */
export function parseVerdict(result: unknown): AnsweredVerdict {
  return answeredSchema.parse(result);
}

/**
 * The answered verdict with each answer joined to the criterion its number
 * names, in the list's order; or how its numbers missed the list, when they do.
 */
export function gradeVerdict(
  answered: AnsweredVerdict,
  listed: readonly ListedCriterion[],
): Verdict | Misnumbered {
  const byNumber = new Map(listed.map((criterion) => [criterion.number, criterion]));
  const answers = new Map<number, AnsweredVerdict["criteria"][number]>();
  const repeated = new Set<number>();
  const unlisted = new Set<number>();
  for (const answer of answered.criteria) {
    if (!byNumber.has(answer.number)) unlisted.add(answer.number);
    else if (answers.has(answer.number)) repeated.add(answer.number);
    else answers.set(answer.number, answer);
  }
  const missing = listed.map(({ number }) => number).filter((number) => !answers.has(number));
  if (missing.length > 0 || unlisted.size > 0 || repeated.size > 0) {
    return { missing, unlisted: [...unlisted], repeated: [...repeated] };
  }
  return {
    criteria: listed.map((criterion) => {
      const { status, evidence } = answers.get(criterion.number) as AnsweredVerdict["criteria"][number];
      return { ...criterion, status, evidence };
    }),
    defects: answered.defects,
  };
}

/** Whether {@link gradeVerdict} found the numbers off. */
export function isMisnumbered(graded: Verdict | Misnumbered): graded is Misnumbered {
  return "missing" in graded;
}

/**
 * The pipeline's own pass decision: no criterion is unmet, the branch made no
 * defect, and at least one criterion is met or left to CI. A verdict of nothing
 * but `unverifiable` is zero evidence, so it fails. A `ci` criterion is
 * evidence still to come, which the pull request's CI gives or withholds
 * ({@link settleCiCriteria}).
 */
export function passes(verdict: Verdict): boolean {
  const counts = countStatuses(verdict);
  return counts.unmet === 0 && verdict.defects.length === 0 && counts.met + counts.ci > 0;
}

export function countStatuses(verdict: Verdict): Record<CriterionStatus, number> {
  const counts: Record<CriterionStatus, number> = { met: 0, unmet: 0, unverifiable: 0, ci: 0 };
  for (const criterion of verdict.criteria) counts[criterion.status] += 1;
  return counts;
}

export function unmetCriteria(verdict: Verdict): GradedCriterion[] {
  return verdict.criteria.filter((criterion) => criterion.status === "unmet");
}

/**
 * The verdict once the wait for CI has ended: a `ci` criterion CI passed is
 * `met`, and one no CI ran on is `unverifiable`, its evidence saying so, since
 * the workflow the verify Stage named never graded it.
 */
export function settleCiCriteria(verdict: Verdict, ciPassed: boolean): Verdict {
  return {
    ...verdict,
    criteria: verdict.criteria.map((criterion) => {
      if (criterion.status !== "ci") return criterion;
      return ciPassed
        ? { ...criterion, status: "met" }
        : {
            ...criterion,
            status: "unverifiable",
            evidence: `${criterion.evidence.trimEnd()} (left to CI, which ran no check on the pull request)`,
          };
    }),
  };
}

/**
 * The verdict's counts as the verify row and the Run's `verified` line say
 * them: the met ones always, and the ones left to CI and the unverifiable ones
 * only when there are any.
 */
export function verifiedSummary(verdict: Verdict): string {
  const counts = countStatuses(verdict);
  return [
    `${counts.met} met`,
    ...(counts.ci === 0 ? [] : [`${counts.ci} to CI`]),
    ...(counts.unverifiable === 0 ? [] : [`${counts.unverifiable} unverifiable`]),
  ].join(" · ");
}
