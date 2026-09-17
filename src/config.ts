import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

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
      })
      .strict()
      .optional(),
    permissionMode: z
      .enum(["auto", "acceptEdits", "bypassPermissions", "manual", "dontAsk", "plan"])
      .optional(),
    ciTimeoutMinutes: z.number().positive().optional(),
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

export type PermissionMode = z.infer<typeof configSchema>["permissionMode"] & string;

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
  checks: string[];
  gates: { checks: boolean; ci: boolean };
  stages: { implement: StageConfig; verify: StageConfig; fix: StageConfig };
  permissionMode: PermissionMode;
  ciTimeoutMinutes: number;
  labels: Labels;
}

const STAGE_DEFAULTS = {
  implement: { maxTurns: 300, maxMinutes: 60 },
  verify: { maxTurns: 80, maxMinutes: 20 },
  fix: { maxTurns: 150, maxMinutes: 40 },
} as const;

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
 * unusable; a missing file is not an error.
 */
export function loadConfig(repoRoot: string): Config {
  const raw = readJson(join(repoRoot, CONFIG_FILENAME));
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid ${CONFIG_FILENAME}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const file = parsed.data;
  return {
    checks: file.checks ?? inferChecks(repoRoot),
    gates: {
      checks: file.gates?.checks ?? true,
      ci: file.gates?.ci ?? true,
    },
    stages: {
      implement: stage(STAGE_DEFAULTS.implement, file.stages?.implement),
      verify: stage(STAGE_DEFAULTS.verify, file.stages?.verify),
      fix: stage(STAGE_DEFAULTS.fix, file.stages?.fix),
    },
    permissionMode: file.permissionMode ?? "auto",
    ciTimeoutMinutes: file.ciTimeoutMinutes ?? 30,
    labels: labels(file.labels),
  };
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
