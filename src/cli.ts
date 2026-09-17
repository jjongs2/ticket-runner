import { parseArgs } from "node:util";
import { ClaudeAgentRunner } from "./adapters/claude-agent-runner.js";
import { execOrThrow } from "./adapters/exec.js";
import { GhTracker } from "./adapters/gh-tracker.js";
import { GitWorkspace } from "./adapters/git-workspace.js";
import { ConfigError, loadConfig } from "./config.js";
import { ensureLabels } from "./labels.js";
import { processTicket } from "./orchestrator.js";
import { newRunId } from "./run-log.js";
import { startupMessages } from "./startup.js";

const USAGE = `agent-pipeline — humans plan, the pipeline executes.

Usage:
  agent-pipeline ticket <n>    Take one Ticket from claimed to merged.

Options:
  -h, --help                   Show this message.`;

/** Exit codes: 0 merged, 1 handed off, 2 the Run never started. */
async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: { help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  const [command, ...rest] = positionals;
  if (command !== "ticket") {
    console.error(`Unknown command \`${command}\`.\n\n${USAGE}`);
    return 2;
  }

  const ticket = Number.parseInt(rest[0] ?? "", 10);
  if (!Number.isInteger(ticket) || ticket <= 0) {
    console.error(`\`ticket\` needs an issue number.\n\n${USAGE}`);
    return 2;
  }

  const repoRoot = await findRepoRoot();
  const config = loadConfig(repoRoot);

  const { refusal, warnings } = startupMessages(config);
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  if (refusal !== undefined) {
    console.error(refusal);
    return 2;
  }

  const tracker = new GhTracker({ cwd: repoRoot });
  const created = await ensureLabels(tracker, config.labels);
  if (created.length > 0) console.log(`Created labels: ${created.join(", ")}`);

  const runId = newRunId();
  const startedAt = Date.now();
  console.log(`agent-pipeline run ${runId} · #${ticket}`);

  const outcome = await processTicket(
    {
      tracker,
      runner: new ClaudeAgentRunner(),
      workspace: new GitWorkspace(repoRoot),
      config,
      repoRoot,
      runId,
      log: (line) => console.log(line),
    },
    ticket,
  );

  const minutes = Math.round((Date.now() - startedAt) / 60_000);
  console.log(`\nagent-pipeline run ${runId} · ${minutes}m\n`);
  if (outcome.outcome === "merged") {
    console.log(`  merged   #${ticket} ${outcome.branch} (PR #${outcome.pullRequest})`);
    return 0;
  }
  console.log(`  handed   #${ticket} ${outcome.branch} · ${outcome.stage} · ${outcome.failure}`);
  return 1;
}

async function findRepoRoot(): Promise<string> {
  const { stdout } = await execOrThrow("git", ["rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 2;
}
