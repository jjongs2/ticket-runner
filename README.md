# agent-pipeline

Humans plan, the pipeline executes.

`agent-pipeline` owns Execution: it claims a Ticket, runs the implement Stage as a
headless `claude -p` session driving `/mattpocock-skills:implement`, runs the Checks
itself, has a fresh session adversarially grade the Acceptance Criteria, opens a PR,
waits for CI and squash-merges. Anything it cannot finish is handed to a human with a
draft PR, a comment and the worktree left in place.

Vocabulary is defined in [`CONTEXT.md`](CONTEXT.md), decisions in [`docs/adr/`](docs/adr/),
conventions in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Requirements

- Node 22 or newer
- `git`, the [`gh`](https://cli.github.com/) CLI authenticated for the repo, and `claude`
- A repo whose Tickets follow the [Planning conventions](CONTRIBUTING.md#issues)

## Usage

```bash
npm install
npm run agent-pipeline -- run         # drain the Frontier
npm run agent-pipeline -- ticket 3    # one named Ticket
```

`run` drains the **Frontier**: the open Tickets labelled `ready-for-agent` that nobody
has claimed and whose native `blocked by` issues have all closed. It takes them one at a
time, lowest number first, and recomputes the Frontier after each one, so a merge that
closes a blocker puts the Ticket it unblocked into the same Run. A Ticket that fails is
handed off and the Run carries on. The Run ends when nothing is left to pick — the
Frontier is empty, or everything still on it is blocked — and prints a summary:

```
agent-pipeline run 2026-09-17T09-00-00-000 · 84m

  merged   #4 Planning guards (PR #12)
  handed   #5 Fix Stage with a single retry · verify · 1 unmet
  skipped  #9 blocked

Frontier blocked.
```

Body text is never read for blockers: only GitHub's native dependencies count
([ADR-0003](docs/adr/0003-github-native-relations-only.md)).

One Run at a time per repo. A second `run`, or a `ticket` started while a `run` holds the
lock, exits immediately naming the holder. The lock is a PID file at
`.agent-pipeline/lock.json`, so a Run that was killed does not block the next one.

A Stage may not start a Run either. Every Stage session runs with `AGENT_PIPELINE_STAGE`
set to the Stage's name, and while that variable is set the CLI refuses before it looks at
the repository, the config or `gh` — `--help` included, because there is nothing a Stage
legitimately needs from this command:

```
$ agent-pipeline ticket 13
Refusing to start: AGENT_PIPELINE_STAGE is set to `implement`, so this shell belongs to
the implement Stage of a Run that is already in progress. A Stage may not run the
pipeline: doing so claims a Ticket on the live tracker, creates a second worktree and
starts a nested Run. Exercise the pipeline through its tests and fakes instead.
```

Exit code `2`, like every other Run that never started. The variable is a tripwire against
an honest mistake rather than a sandbox, so every Stage prompt carries the same instruction
in words. It is also written into the command line saved beside each Stage's transcript, so
reproducing a Stage by hand reproduces its environment too.

`ticket <n>` takes exactly one Ticket from claimed to merged:

1. assign it, swap `ready-for-agent` for `in-progress`
2. create `agent/<n>-<slug>` from `main` in a worktree under `.worktrees/`
3. implement Stage
4. the configured Checks, run by the pipeline itself
5. verify Stage, graded against the Ticket's Acceptance Criteria
6. rebase on `main`, open a PR that closes the Ticket, wait for CI
7. squash-merge, pull `main`, remove the worktree

Any failure hands the Ticket over instead: `ready-for-human`, unassigned, draft PR,
branch and worktree preserved. Exit code is `0` when nothing was handed off, `1` when
something was, and `2` when the Run never started.

Every Stage writes its exact command line, stdout, stderr and stream-json transcript to
`.agent-pipeline/runs/<runId>/<n>/`, so any Stage can be reproduced by hand.

## Configuration

`agent-pipeline.json` at the repo root. Every field is optional.

```jsonc
{
  // Commands run in the worktree after implement.
  // Default: `npm test` and `npm run typecheck`, whichever package.json defines.
  "checks": ["npm test", "npm run typecheck"],

  // Turn a gate off to run without a net; each one prints a warning at start.
  "gates": { "checks": true, "ci": true },

  "stages": {
    // Defaults: implement 300 turns / 60 min, verify 80 / 20, fix 150 / 40.
    "implement": {
      "model": "claude-opus-5",
      "maxTurns": 300,
      "maxMinutes": 60,
      "extraPrompt": "Repo-specific instructions appended to the Stage prompt."
    }
  },

  // Passed to every Stage, which also always runs with `--permission-prompts none`.
  // One of "auto", "acceptEdits" or "bypassPermissions".
  "permissionMode": "auto",

  "ciTimeoutMinutes": 30,

  // Rename the triage vocabulary if this repo uses different label strings.
  "labels": { "inProgress": "in-progress" }
}
```

With `gates.checks` on and no Check command configured or inferable, the command refuses
to start rather than merging unverified code. Missing labels are created on every Run.

## Development

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
```

The orchestrator depends only on the three ports — `Tracker`, `AgentRunner` and
`Workspace` — and is tested end to end through in-memory fakes. The git-backed
`Workspace` is tested against a real temporary repository. No test spawns `gh` or
`claude`.
