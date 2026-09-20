import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PERMISSION_MODES, type PermissionMode } from "./ports/agent-runner.js";

export const CONFIG_FILENAME = "agent-pipeline.json";

/** The default model for every Stage: Opus 5. */
const DEFAULT_MODEL = "claude-opus-5";

/** Thrown when the config file exists but cannot be used. */
export class ConfigError extends Error {}

const stageSchema = z
  .object({
    model: z.string().min(1).optional(),
    maxTurns: z.number().int().positive().optional(),
    maxMinutes: z.number().positive().optional(),
    extraPrompt: z.string().optional(),
  })
  .strict();

const configSchema = z
  .object({
    baseBranch: z.string().min(1).optional(),
    lanes: z.number().int().positive().optional(),
    checks: z.array(z.string().min(1)).optional(),
    gates: z
      .object({ checks: z.boolean().optional(), ci: z.boolean().optional() })
      .strict()
      .optional(),
    stages: z
      .object({
        implement: stageSchema.optional(),
        verify: stageSchema.optional(),
        fix: stageSchema.optional(),
        conflict: stageSchema.optional(),
      })
      .strict()
      .optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    ciTimeoutMinutes: z.number().positive().optional(),
    ciGraceMinutes: z.number().positive().optional(),
    checkTimeoutMinutes: z.number().positive().optional(),
    labels: z
      .object({
        needsTriage: z.string().min(1).optional(),
        needsInfo: z.string().min(1).optional(),
        readyForAgent: z.string().min(1).optional(),
        readyForHuman: z.string().min(1).optional(),
        wontfix: z.string().min(1).optional(),
        inProgress: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface StageConfig {
  model: string;
  maxTurns: number;
  maxMinutes: number;
  extraPrompt: string;
}

export interface Labels {
  needsTriage: string;
  needsInfo: string;
  readyForAgent: string;
  readyForHuman: string;
  wontfix: string;
  inProgress: string;
}

export interface Config {
  /**
   * The branch a Run branches from, rebases onto, merges into and pulls, where
   * the config names one. Absent means the Target's default branch on GitHub,
   * which is what {@link import("./base-branch.js").resolveBaseBranch} asks for.
   */
  baseBranch?: string;
  /**
   * How many Tickets a Run may hold at once, one Lane per Ticket. The Checks of
   * different Lanes run in different worktrees at the same time, so a Target
   * whose Checks share a port or a database stays at the default of one.
   */
  lanes: number;
  checks: string[];
  gates: { checks: boolean; ci: boolean };
  stages: {
    implement: StageConfig;
    verify: StageConfig;
    fix: StageConfig;
    conflict: StageConfig;
  };
  permissionMode: PermissionMode;
  ciTimeoutMinutes: number;
  /**
   * How long a pull request GitHub has registered no check run for still counts
   * as pending. A Target whose Actions queue slowly raises it; a Target with no
   * CI workflow pays it once per Landing, so it is not the CI timeout.
   */
  ciGraceMinutes: number;
  /**
   * How long any one Check command may run before it is killed. One number for
   * the whole pipeline, and every command gets the whole of it.
   */
  checkTimeoutMinutes: number;
  labels: Labels;
}

const STAGE_DEFAULTS = {
  implement: { maxTurns: 300, maxMinutes: 60 },
  verify: { maxTurns: 80, maxMinutes: 20 },
  fix: { maxTurns: 150, maxMinutes: 40 },
  // Resolving one rebase is narrower work than mending a defect, and the skill
  // has the Checks to run before it finishes.
  conflict: { maxTurns: 120, maxMinutes: 30 },
} as const;

/**
 * The wall-clock limit a Check runs under when the config names none. Longer
 * than any suite a Ticket-sized change should have, so reaching it means the
 * command hung rather than that it was slow.
 */
const DEFAULT_CHECK_TIMEOUT_MINUTES = 15;

/**
 * How long "no checks yet" is given when the config names nothing. GitHub has
 * taken over three minutes to register a check run (#119), and the Landing is
 * serialized, so this is long enough to cover that and short enough that a
 * Target with no CI workflow does not hold the other Lanes up for a CI timeout.
 */
const DEFAULT_CI_GRACE_MINUTES = 5;

/**
 * The Lane count a Target that says nothing gets: one, which is a Run that takes
 * its Tickets one after another. Sharing a machine is opt-in, because only the
 * Target knows whether its Checks can.
 */
const DEFAULT_LANES = 1;

const LABEL_DEFAULTS: Labels = {
  needsTriage: "needs-triage",
  needsInfo: "needs-info",
  readyForAgent: "ready-for-agent",
  readyForHuman: "ready-for-human",
  wontfix: "wontfix",
  inProgress: "in-progress",
};

/**
 * Read the config file, fill in every default, and infer the Check commands
 * from package.json when the config does not name them.
 *
 * Throws {@link ConfigError} naming the offending field when the file is
 * unusable; a missing file is not an error. `version` is the Version doing the
 * refusing, which the message for an unknown key carries.
 */
export function loadConfig(repoRoot: string, version: string): Config {
  const raw = readJson(join(repoRoot, CONFIG_FILENAME));
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ConfigError(refusal(parsed.error, version));
  }

  const file = parsed.data;
  return {
    // Spread, not `baseBranch: file.baseBranch`: the field is absent rather
    // than undefined when the config file names none.
    ...(file.baseBranch === undefined ? {} : { baseBranch: file.baseBranch }),
    lanes: file.lanes ?? DEFAULT_LANES,
    checks: file.checks ?? inferChecks(repoRoot),
    gates: {
      checks: file.gates?.checks ?? true,
      ci: file.gates?.ci ?? true,
    },
    stages: {
      implement: stage(STAGE_DEFAULTS.implement, file.stages?.implement),
      verify: stage(STAGE_DEFAULTS.verify, file.stages?.verify),
      fix: stage(STAGE_DEFAULTS.fix, file.stages?.fix),
      conflict: stage(STAGE_DEFAULTS.conflict, file.stages?.conflict),
    },
    permissionMode: file.permissionMode ?? "auto",
    ciTimeoutMinutes: file.ciTimeoutMinutes ?? 30,
    ciGraceMinutes: file.ciGraceMinutes ?? DEFAULT_CI_GRACE_MINUTES,
    checkTimeoutMinutes: file.checkTimeoutMinutes ?? DEFAULT_CHECK_TIMEOUT_MINUTES,
    labels: labels(file.labels),
  };
}

/**
 * Why the file was refused, and — for an unknown key — which Version refused it.
 *
 * The schema is strict, so a key this install has never heard of is refused by
 * name. That is the right answer to a typo and a confusing one to a key a newer
 * Version added, and on a machine running a stale install the two look exactly
 * the same. So the Version is said out loud, and the config file itself is left
 * without one to carry (ADR-0007).
 */
function refusal(error: z.ZodError, version: string): string {
  const detail = error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  const said = `Invalid ${CONFIG_FILENAME}: ${detail}`;
  if (!error.issues.some((issue) => issue.code === "unrecognized_keys")) return said;
  return `${said}. Refused by agent-pipeline ${version}, so the key may be newer than this install.`;
}

/** Config label overrides win, but only where the file actually names one. */
function labels(
  configured: { [K in keyof Labels]?: string | undefined } | undefined,
): Labels {
  const merged = { ...LABEL_DEFAULTS };
  for (const key of Object.keys(LABEL_DEFAULTS) as (keyof Labels)[]) {
    const override = configured?.[key];
    if (override !== undefined) merged[key] = override;
  }
  return merged;
}

function stage(
  defaults: { maxTurns: number; maxMinutes: number },
  configured: z.infer<typeof stageSchema> | undefined,
): StageConfig {
  return {
    model: configured?.model ?? DEFAULT_MODEL,
    maxTurns: configured?.maxTurns ?? defaults.maxTurns,
    maxMinutes: configured?.maxMinutes ?? defaults.maxMinutes,
    extraPrompt: configured?.extraPrompt ?? "",
  };
}

/** `npm test` and `npm run typecheck`, whichever package.json actually defines. */
function inferChecks(repoRoot: string): string[] {
  const pkg = readJson(join(repoRoot, "package.json"));
  const scripts =
    pkg && typeof pkg === "object" && "scripts" in pkg ? pkg.scripts : undefined;
  if (!scripts || typeof scripts !== "object") return [];

  const checks: string[] = [];
  if ("test" in scripts) checks.push("npm test");
  if ("typecheck" in scripts) checks.push("npm run typecheck");
  return checks;
}

function readJson(path: string): Record<string, unknown> | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(contents) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(`Invalid JSON in ${path}: ${(error as Error).message}`);
  }
}
