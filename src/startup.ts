import { CONFIG_FILENAME, type Config } from "./config.js";

export interface StartupMessages {
  /** When set, the Run must not start; this explains why. */
  refusal?: string;
  warnings: string[];
}

/**
 * What the human has to be told before a Run starts: a refusal when no Check
 * command is named or inferable, and a warning when the config names none on
 * purpose.
 */
export function startupMessages(config: Config): StartupMessages {
  if (config.checks.length > 0) return { warnings: [] };

  if (!config.checksNamed) {
    return {
      refusal: [
        "No Check commands are configured and none could be inferred from package.json.",
        "The Stage prompts name them, and a red CI is graded with them at the branch's merge-base with the base branch.",
        `Add them to \`checks\` in ${CONFIG_FILENAME}, add \`test\` and \`typecheck\` scripts to package.json,`,
        `or write \`"checks": []\` in ${CONFIG_FILENAME} to run with no Check command.`,
      ].join(" "),
      warnings: [],
    };
  }

  return {
    warnings: [
      `No Check command: \`checks\` is \`[]\` in ${CONFIG_FILENAME}, so the Stage prompts name none and a red CI is not graded at the branch's merge-base.`,
    ],
  };
}
