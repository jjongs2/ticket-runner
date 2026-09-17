import { CONFIG_FILENAME, type Config } from "./config.js";

export interface StartupMessages {
  /** When set, the Run must not start; this explains why. */
  refusal?: string;
  warnings: string[];
}

/**
 * What the human has to be told before a Run starts: a refusal when nothing
 * would gate a merge, and a warning for each gate they turned off on purpose.
 */
export function startupMessages(config: Config): StartupMessages {
  const warnings: string[] = [];
  if (!config.gates.checks) {
    warnings.push("Checks gate off: nothing deterministic will gate a merge.");
  }
  if (!config.gates.ci) {
    warnings.push("CI gate off: a pull request with no checks will still be merged.");
  }

  if (config.gates.checks && config.checks.length === 0) {
    return {
      refusal: [
        "No Check commands are configured and none could be inferred from package.json.",
        `Add them to \`checks\` in ${CONFIG_FILENAME}, add \`test\` and \`typecheck\` scripts to package.json,`,
        `or set \`gates.checks\` to false in ${CONFIG_FILENAME} to run without a net.`,
      ].join(" "),
      warnings,
    };
  }

  return { warnings };
}
