import { ClaudeAgentRunner } from "./adapters/claude-agent-runner.js";
import { GhTracker } from "./adapters/gh-tracker.js";
import { GitWorkspace } from "./adapters/git-workspace.js";
import { findRepoRoot } from "./adapters/repo-root.js";
import { pipelineRepository, pipelineVersion } from "./adapters/version.js";
import { USAGE, readCommandLine } from "./command-line.js";
import { ConfigError, loadConfig } from "./config.js";
import { initTarget } from "./init.js";
import { newRunId } from "./run-log.js";
import { nestedRunRefusal } from "./stage-guard.js";
import { startRun } from "./start.js";
import { requestStop } from "./stop.js";

/**
 * Exit codes: 0 nothing handed off, 1 at least one hand-off, 2 nothing was
 * taken at all — the Run never started, or `ticket <n>` named an issue a guard
 * refused. `init` reads them as its own: 0 every reported item passed, 1 one of
 * them is the human's to put right, 2 a Stage's shell was refused. `stop` reads
 * 0 as a Stop sent and 2 as no Run there was anything to ask.
 */
async function main(argv: string[]): Promise<number> {
  // First, before the repo, the config, `gh` or even `--help`: a Stage's shell
  // may not start a Run of the pipeline it is working on.
  const nested = nestedRunRefusal(process.env);
  if (nested !== undefined) {
    console.error(nested);
    return 2;
  }

  const read = readCommandLine(argv);
  if (read.kind === "refused") {
    console.error(read.message);
    return 2;
  }

  // Resolved once, here, and handed to everything that stamps it the way the
  // run id is: a Run whose summary, comments, State files and transcripts all
  // read it separately could report four different things (ADR-0007).
  const version = await pipelineVersion();
  // The repository a newer Version would be published on, read from the same
  // package the number came from, so a fork asks about itself (ADR-0007).
  const repository = pipelineRepository();
  if (read.kind === "version") {
    console.log(version);
    return 0;
  }

  if (read.kind === "usage") {
    console.log(USAGE);
    return read.exitCode;
  }

  // Before the config and the Target's readiness, which a Stop needs none of:
  // a Run is already running, so whatever they would have refused it over was
  // answered when it started.
  if (read.kind === "stop") {
    const root = await findRepoRoot();
    return await requestStop({ workspace: new GitWorkspace(root) });
  }

  if (read.kind === "init") {
    const root = await findRepoRoot();
    // No Run lock, because no Ticket is claimed, and no startup refusal: the
    // missing Checks it would refuse over are one of the things `init` reports.
    return initTarget({
      repoRoot: root,
      version,
      repository,
      config: loadConfig(root, version),
      tracker: new GhTracker({ cwd: root }),
      runner: new ClaudeAgentRunner(),
    });
  }

  const repoRoot = await findRepoRoot();
  const config = loadConfig(repoRoot, version);
  return startRun({
    work: read.work,
    lanes: read.lanes,
    repoRoot,
    config,
    // The one setting an adapter holds rather than being handed per call: the
    // CI wait's grace is the tracker's own, so the Target's minutes reach it here.
    tracker: new GhTracker({
      cwd: repoRoot,
      checksGraceMs: config.ciGraceMinutes * 60_000,
    }),
    runner: new ClaudeAgentRunner(),
    workspace: new GitWorkspace(repoRoot),
    runId: newRunId(),
    version,
    repository,
    // Every argument, `--lanes` included, so whoever meets the lock sees how
    // the Run was started.
    command: ["agent-pipeline", ...argv].join(" "),
  });
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 2;
}
