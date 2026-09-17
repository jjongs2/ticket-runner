import { z } from "zod";

/**
 * The structured result of the verify Stage: one status per Acceptance
 * Criterion, with the evidence the session gathered for it.
 */
const criterionSchema = z.object({
  text: z.string(),
  status: z.enum(["met", "unmet", "unverifiable"]),
  evidence: z.string(),
});

const verdictSchema = z.object({
  criteria: z.array(criterionSchema).min(1),
  /** The agent's own opinion. The pipeline recomputes it; see {@link passes}. */
  pass: z.boolean(),
});

export type Criterion = z.infer<typeof criterionSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type CriterionStatus = Criterion["status"];

/** The `--json-schema` the verify Stage is invoked with. */
export const VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "The Acceptance Criterion verbatim" },
          status: { type: "string", enum: ["met", "unmet", "unverifiable"] },
          evidence: {
            type: "string",
            description: "What you ran or read, and what it showed",
          },
        },
        required: ["text", "status", "evidence"],
        additionalProperties: false,
      },
    },
    pass: { type: "boolean" },
  },
  required: ["criteria", "pass"],
  additionalProperties: false,
} as const;

/** Parse the verify Stage's structured output. Throws when it is unusable. */
export function parseVerdict(result: unknown): Verdict {
  return verdictSchema.parse(result);
}

/**
 * The pipeline's own pass decision: no criterion is unmet and at least one is
 * met. A Verdict of nothing but `unverifiable` is zero evidence, so it fails.
 */
export function passes(verdict: Verdict): boolean {
  const counts = countStatuses(verdict);
  return counts.unmet === 0 && counts.met > 0;
}

export function countStatuses(verdict: Verdict): Record<CriterionStatus, number> {
  const counts: Record<CriterionStatus, number> = { met: 0, unmet: 0, unverifiable: 0 };
  for (const criterion of verdict.criteria) counts[criterion.status] += 1;
  return counts;
}

export function unmetCriteria(verdict: Verdict): Criterion[] {
  return verdict.criteria.filter((criterion) => criterion.status === "unmet");
}
