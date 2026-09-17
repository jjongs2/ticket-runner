# agent-pipeline

Humans plan, the pipeline executes.

`agent-pipeline` owns Execution: it claims a Ticket, runs the implement Stage as a
headless `claude -p` session driving `/mattpocock-skills:implement`, runs the Checks
itself, has a fresh session adversarially grade the Acceptance Criteria, opens a PR,
waits for CI and squash-merges. One failure along the way buys a fix Stage and a
second pass. Anything it still cannot finish is handed to a human with a draft PR, a
comment and the worktree left in place.

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
  skipped  #7 no-criteria
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

1. run the guards, then assign it and swap `ready-for-agent` for `in-progress`
2. create `agent/<n>-<slug>` from `main` in a worktree under `.worktrees/`
3. implement Stage
4. the configured Checks, run by the pipeline itself
5. verify Stage, graded against the Ticket's Acceptance Criteria
6. rebase on `main`, resolving a conflict if one comes up, open a PR that closes the
   Ticket, wait for CI
7. squash-merge, pull `main`, remove the worktree

A failing Check, a Verdict with an `unmet` criterion, a red CI, or a rebase conflict the
conflict Stage could not resolve spends the Ticket's **fix budget** rather than ending
it. A fresh session runs in the same worktree on the
same branch, given the kind of failure and the evidence that was captured — the failing
Check's output, the unmet criteria with theirs, or the CI summary — and asked for the
regression test a gap the Verdict found should have had. Step 4 then starts again, so
the fix is graded by every gate from the Checks onwards. The budget is one per Ticket:
a second failure of any kind, including a kind the fix Stage never touched, is a
hand-off, and the comment says the budget had already been used.

Nothing else spends the budget. A Stage that never came back, a Verdict with no evidence in
it, CI that timed out or never ran — none of these is a defect in the code a fresh session
could go and mend.

A failure the fix budget cannot cover hands the Ticket over instead: `ready-for-human`,
unassigned, draft PR, branch and worktree preserved. Exit code is `0` when nothing was
handed off, `1` when something was, and `2` when nothing was taken at all — the Run
never started, or a guard refused the issue named. A `run` that skipped every candidate
still exits `0`.

Every Stage writes its exact command line, stdout, stderr and stream-json transcript to
`.agent-pipeline/runs/<runId>/<n>/`, so any Stage can be reproduced by hand. The command
line lands there before the Stage starts, and its output as the Stage prints it, so a Run
killed mid-Stage still leaves behind what it had reached. A Ticket that spends its fix
budget writes the fix Stage and the pass it bought to `<n>/retry/`, so the transcripts of
the pass that failed survive alongside them.

## What a Ticket gets told

A Run reports on a Ticket a dozen times, so it says almost all of it in one comment.
The first Stage posts a **progress comment** carrying a hidden marker and a table, and
every Stage after it rewrites that same comment in place — so the Ticket gets one
notification, not a dozen, and the table reads top to bottom as the Run happened:

```
| Stage | Outcome | Turns | Duration |
|---|---|---|---|
| implement | ✅ committed | 46 | 21m |
| checks | ❌ `npm test` failed | – | 2m |
| fix | ✅ committed | 12 | 6m |
| checks | ✅ passed | – | 2m |
| verify | ✅ 6 met · 1 unverifiable | 9 | 4m |
| ci | ✅ passed | – | 3m |
| merge | ✅ #31 | – | – |
```

A later Run finds that comment by its marker and carries on in it rather than starting a
second table. Details never go in a cell: a hand-off, its evidence and a guard warning
stay comments of their own, because those are the ones worth a notification.

When the Ticket merges, every criterion the Verdict marked `met` is ticked where it is
written, in the body or in the comment triage posted it in. An `unverifiable` one is
left unticked: nobody gathered the evidence that would justify the tick.

## Rebase conflicts

A branch that will not replay onto `main` is not a defect in the branch: `main` moved on
while the Ticket was being implemented. So the rebase is left where git stopped it and one
**conflict Stage** runs in the worktree, driving
`/mattpocock-skills:resolving-merge-conflicts` with the Ticket and git's own output. It has
its own turn and wall-clock limits, and it does not spend the fix budget.

The worktree decides whether it worked, not how the session ended: the rebase has to be
finished with no merge commit standing in for it, `main` an ancestor of the branch, nothing
left unmerged and no conflict marker left in any file the tree carries, staged or not. A
Stage that ran out of turns having already finished the rebase has still done the job; one
that came back clean because it quietly abandoned the rebase has not.
The Checks then run again, because the resolution is code no gate has seen yet, and only then
does the pull request open.

A conflict that outlives the Stage is aborted back out of the worktree — a half-finished
rebase would trap whoever works there next — and follows the ordinary failure path: the fix
Stage if the budget is unspent, a hand-off if it is not.

## Guards

Planning is human work, and every candidate is guarded against the known ways it
goes wrong before a Run claims it. A candidate that fails a guard is passed over,
gets one warning comment saying what to fix, and appears in the summary as
`skipped` with the guard's reason:

| Reason | What the candidate did | What the pipeline does |
|---|---|---|
| `spec` | has native sub-issues, so it is a Spec | skips it and removes `ready-for-agent`, since its Tickets are picked up individually |
| `no-criteria` | has no `- [ ]` checkbox in its body or comments, so verify has nothing to grade | skips it and leaves the label, since a comment can still supply criteria |
| `body-only-blockers` | has a `Blocked by` line naming issues with no native edge | skips it and leaves the label; the body line is never read as a blocker |

The warning is posted at most once per reason, so a nightly Run that meets the
same unfixed candidate again says nothing further. `ticket <n>` applies the same
guards, and refuses in silence when the issue named is already assigned or is not
labelled `ready-for-agent`: it may not steal a claimed Ticket or take an
untriaged one.

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
    // Defaults: implement 300 turns / 60 min, verify 80 / 20, fix 150 / 40,
    // conflict 120 / 30.
    "implement": {
      "model": "claude-opus-5",
      "maxTurns": 300,
      "maxMinutes": 60,
      "extraPrompt": "Repo-specific instructions appended to the Stage prompt."
    },
    "fix": { "model": "claude-opus-5", "maxTurns": 150, "maxMinutes": 40 },
    "conflict": { "model": "claude-opus-5", "maxTurns": 120, "maxMinutes": 30 }
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
