# agent-pipeline

Humans plan, the pipeline executes.

`agent-pipeline` owns Execution in the **Target**, the repository the command was started
in: it claims a Ticket, runs the implement Stage as a headless `claude -p` session driving
`/mattpocock-skills:implement`, runs the Checks itself, has a fresh session adversarially
grade the Acceptance Criteria, opens a PR, waits for CI and squash-merges. One failure
along the way buys a fix Stage and a second pass. Anything it still cannot finish is
handed to a human with a draft PR, a comment and the worktree left in place. A Stage the
subscription rate limit stops is nobody's fault, so the Ticket is released instead, the
Run ends there, and a later Run resumes it.

Vocabulary is defined in [`CONTEXT.md`](CONTEXT.md), decisions in [`docs/adr/`](docs/adr/),
conventions in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Requirements

What a Target needs before the pipeline can work in it:

- Node 22 or newer
- `git`, the [`gh`](https://cli.github.com/) CLI authenticated for the Target, and `claude`
  with the `mattpocock-skills` plugin installed
- A GitHub repository whose Tickets follow the [Planning conventions](CONTRIBUTING.md#issues)
- A CI workflow, and a Check the pipeline can run itself — `test` and `typecheck` scripts in
  `package.json`, or commands named in the config file

## Install

Once, globally, from GitHub. The same line updates it:

```bash
npm install -g github:jjongs2/agent-pipeline
```

## Set a Target up

```bash
cd ~/code/acme
agent-pipeline init
```

`init` puts in place everything a Run expects to find in the Target and reports on
everything only a human can put there. Running it twice is running it once: every write asks
first whether the Target already has the thing. It commits nothing, so what it wrote reaches
the Target's history through whatever process that repository uses, and it takes no Run lock,
because it claims no Ticket.

It writes the two gitignore lines for `.worktrees/` and `.agent-pipeline/`, an empty
`agent-pipeline.json`, the pipeline's conventions document at
[`docs/agents/pipeline-conventions.md`](docs/agents/pipeline-conventions.md), and a section
in `CLAUDE.md` pointing at it. The files a human owns only ever gain lines; the conventions
document is the pipeline's own text, so a Target carrying an older copy is rewritten and told
that it was. On GitHub it creates whichever of the six triage labels are missing and turns
squash merging on, touching no other merge setting.

Then it reports one line per item that is yours — whether `gh` is authenticated, `claude`
runs, the `mattpocock-skills` plugin is installed, a CI workflow exists under
`.github/workflows`, and a Check is configured or inferable:

```
Checked:
  ✓ `gh` is authenticated
  ✓ `claude` runs
  ✓ the `mattpocock-skills` plugin is installed
  ✗ no CI workflow in `.github/workflows` — a pull request with no checks is never merged
  ✓ a Check is configured or inferable: npm test, npm run typecheck

Not ready: 1 item is yours to put right.
```

Exit code is `1` while any reported item is failing and `0` once none is, so
`agent-pipeline init && agent-pipeline run` stops before a doomed Run.

## Usage

```bash
agent-pipeline run         # drain the Frontier
agent-pipeline ticket 3    # one named Ticket
```

Both refuse a Target `init` has not set up rather than repairing it. A gitignore missing one
of the two directories, a missing triage label, no conventions document, or a `CLAUDE.md`
that does not point at one: whichever comes first is a refusal with exit code `2` that names
the item and the command that puts it right.

```
$ agent-pipeline run
This Target is not set up: `.gitignore` does not ignore `.worktrees/`. Run
`agent-pipeline init` here and start again; a Run puts nothing in place itself.
```

The check is presence, never content: a Target carrying an older copy of the conventions
document starts, and the next `init` brings it up to date.

`run` drains the **Frontier**: the open Tickets labelled `ready-for-agent` that nobody
has claimed and whose native `blocked by` issues have all closed. It takes them one at a
time, lowest number first, and recomputes the Frontier after each one, so a merge that
closes a blocker puts the Ticket it unblocked into the same Run. A Ticket that fails is
handed off and the Run carries on; one the rate limit stopped is released and ends the Run
there. Otherwise the Run ends when nothing is left to pick — the Frontier is empty, or
everything still on it is blocked — and prints a summary:

```
agent-pipeline run 2026-09-17T09-00-00-000 · 84m

  merged   #4 Planning guards (PR #12)
  noted    #8 comment · from #4 implement · the CLI help drifts
  handed   #5 Fix Stage with a single retry · verify · 1 unmet
  skipped  #7 no-criteria
  skipped  #9 blocked

Frontier blocked.
```

Body text is never read for blockers: only GitHub's native dependencies count
([ADR-0003](docs/adr/0003-github-native-relations-only.md)).

One Run at a time per Target. A second `run`, or a `ticket` started while a `run` holds the
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
2. create `agent/<n>-<slug>` from the base branch in a worktree under `.worktrees/`,
   refusing the Ticket if that branch already exists
3. implement Stage
4. the configured Checks, run by the pipeline itself
5. verify Stage, graded against the Ticket's Acceptance Criteria
6. rebase on the base branch, resolving a conflict if one comes up, open a PR that closes
   the Ticket, wait for CI
7. squash-merge, pull the base branch, remove the worktree

A failing Check, a Check killed at its wall-clock limit, a Verdict with an `unmet`
criterion, a red CI, or a rebase conflict the conflict Stage could not resolve spends the
Ticket's **fix budget** rather than ending it. A fresh session runs in the same worktree
on the same branch, given the kind of failure and the evidence that was captured — the
failing Check's output, the unmet criteria with theirs, or the CI summary — and asked for
the regression test a gap the Verdict found should have had. Step 4 then starts again, so
the fix is graded by every gate from the Checks onwards. The budget is one per Ticket:
a second failure of any kind, including a kind the fix Stage never touched, is a
hand-off, and the comment says the budget had already been used.

Nothing else spends the budget. A Stage that never came back, a Verdict with no evidence in
it, CI that timed out or never ran — none of these is a defect in the code a fresh session
could go and mend. A Check that timed out is the one timeout that does spend it: a Check
runs the branch's own code on this machine, so a suite that hangs or a server a Stage left
in the foreground is a defect in that code, which is exactly what a fix Stage is for. CI
that never finishes is somebody else's infrastructure, and stays budget-free.

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

## Rate limits

A Stage that comes back rate-limited has failed at nothing: the subscription ran out of
room, and blaming the Ticket for it would spend its fix budget on a fix Stage that would
be stopped in turn. So the Ticket is **released** rather than handed over. The Claim is
undone — assignee off, `in-progress` off, `ready-for-agent` back on — and the branch and
worktree stay exactly as the Stage left them. Nobody is notified, because nobody has
anything to do about it: the `⏸ rate limited` row in the progress table is the whole
report. A released Ticket does not change the exit code, so a Run the limit stopped still
exits `0`.

What the release leaves behind is the **State file** the Ticket has been keeping since it
was claimed, at `.agent-pipeline/state/ticket-<n>.json`, naming the state it reached, its
branch, whether the fix budget was already spent, and the pull request if one is open
([ADR-0004](docs/adr/0004-resume-state-is-a-local-file.md)):

```json
{
  "ticket": 8,
  "branch": "agent/8-rate-limit-release-and-resume",
  "state": "implemented",
  "fixUsed": false,
  "runId": "2026-09-17T09-00-00-000",
  "updatedAt": "2026-09-17T10:14:02.511Z"
}
```

A Run started once the limit has reset finds the Ticket back on the Frontier, reads that
file and carries on in the worktree and on the branch it names rather than creating new
ones: `claimed` runs the implement Stage again, `implemented` goes straight to the Checks.
The fix budget is resumed as it was recorded, so a Ticket that had already spent it is
handed off at its next failure — resuming buys no second chances. The file is ignored if
the worktree it names has since been cleaned up — the Ticket is then taken from the top,
which needs a branch to create, and the branch may still be there.

A branch nobody can account for is not reused. So before the worktree is created the
pipeline asks whether the Ticket's branch already exists locally, and hands the Ticket
over at `setup` if it does, with a failure that names the branch and says what to do with
it: delete it with `git branch -D <branch>` if the work on it is abandoned, or finish it
by hand, then relabel the Ticket `ready-for-agent`. That is the ordinary hand-off —
`ready-for-human` on, `in-progress` off, unassigned, State file cleared — and it costs the
Ticket nothing, because the fix budget is never spent at `setup`. The same refusal meets a
human who finished a handed-off Ticket and deleted `.worktrees/ticket-<n>` without deleting
its branch, and a handed-off Ticket relabelled with its worktree untouched — there the
failure names the worktree the branch is checked out in, since a branch git is holding is
not one `git branch -D` can take.

The Run the limit stops ends at that Release. It does not wait for the limit to reset, and
it takes nothing else: the limit that stopped one Stage would stop the next, so walking the
rest of the Frontier would spend a Claim, a worktree and a doomed Stage per Ticket to learn
what the first Release already said. Its summary ends with `Rate limited.` instead of
`Frontier empty.`, and says nothing about the Tickets it never reached — a released one is
back on the Frontier, an unreached stranded one still wears its Claim, and the Run started
once the limit has reset picks up both.

## A Run that did not come back

A Run that is killed — Ctrl-C, an OOM, a machine that went away — releases nothing. The
Ticket it was holding keeps its Claim, and its branch and worktree keep the work. So the
State file is not written by the release; it is written as part of the Claim and kept
current as the Ticket advances: `claimed` when the Claim is made, `implemented` once the
implement Stage has committed, the pull request once one is open, the fix budget once a fix
Stage has come back. It is removed when the Ticket merges and when it is handed off, which
are the two ways a Ticket stops being resumable.

A Ticket left like that is a **stranded Ticket**: state recorded locally, and the Claim
still on the board. No Frontier can offer one — it is claimed — so before a `run` computes
the Frontier at all it sweeps the local State files and resumes every stranded Ticket, in
ascending number, in the worktree and on the branch it already has. The Claim stays exactly
as it is: nothing is re-assigned, nothing is relabelled, and nobody is notified.
`ticket <n>` naming a stranded Ticket resumes it too, where it would otherwise refuse it
as claimed.

Nothing records a process id. One Run at a time holds the lock for a checkout and the State
file is local to that checkout, so a Run that holds the lock and finds a Ticket still
wearing this checkout's Claim knows the Run that claimed it is gone.

Not everything the sweep finds is stranded, and it resumes nothing else:

- a Ticket whose Claim has come off is a released Ticket, and is left to the Frontier
- a Ticket that has closed has nothing left to resume, so its State file is removed
- a Ticket somebody else now holds is left alone and logged — a human took it over
- a Ticket whose worktree is gone is taken from the top, in place, keeping its Claim —
  which is a hand-off at `setup` when the branch it named is still there

Being killed is still worse than stopping properly: whatever the Stage was doing is lost,
and a worktree the Run left mid-rebase is aborted back to the branch tip before the Checks
grade it. What the sweep buys is that no human has to unpick the labels and the assignee
before the Ticket can move again.

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

## Notes for other Tickets

A Stage sent to implement one Ticket keeps meeting things that are not it: a
defect in code it only had to read, a gap nothing tracks yet. Fixing them widens
the Ticket past the criteria verify grades, and ignoring them loses them in a
transcript nobody opens.

So the implement and fix Stages end with a list of **Notes**, and the pipeline
routes each one out of the session:

- a Note that names a Ticket becomes a comment on it, saying which Ticket and
  Stage it came from
- a Note that names none opens an issue labelled `needs-triage`, which is where
  the triage on-ramp starts
- a Note that names the Ticket its own Stage is working on counts as naming
  none: commenting there would file the finding under an issue this very Run is
  about to close

A Note is never acted on where it was found, and never changes the current
Ticket's scope. Checkboxes in one are escaped before it is posted: `- [ ]` is
Acceptance Criteria to everything that reads a Ticket, and a Note is not asking
for any. The Run summary lists every Note with the issue it reached, so a night
of work says what it noticed as well as what it merged.

Routing a Note can never cost a Ticket, and the triage queue is the fallback for
all of it: a number the Stage invented, or a Ticket that will not take the
comment, opens an issue carrying the number it was reaching for rather than
dropping the finding. Only a tracker that refuses that too loses a Note, and it
loses that one and nothing else. A Stage that fails still has its Notes routed,
because a session that ran out of turns still noticed whatever it noticed.

## Rebase conflicts

A branch that will not replay onto the base branch is not a defect in the branch: the base
branch moved on while the Ticket was being implemented. So the rebase is left where git
stopped it and one **conflict Stage** runs in the worktree, driving
`/mattpocock-skills:resolving-merge-conflicts` with the Ticket and git's own output. It has
its own turn and wall-clock limits, and it does not spend the fix budget.

The worktree decides whether it worked, not how the session ended: the rebase has to be
finished with no merge commit standing in for it, the base branch an ancestor of the
branch, nothing left unmerged and no conflict marker left in any file the tree carries,
staged or not. A
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

`agent-pipeline.json` at the Target's root. Every field is optional.

The base branch — what a Run branches from, rebases onto, targets its pull requests at and
pulls once they merge — is asked of GitHub once at the start of a Run, so a Target on
`master` needs no config file at all.

```jsonc
{
  // The branch a Run merges into.
  // Default: whatever GitHub calls the Target's default branch.
  "baseBranch": "main",

  // How many Tickets a Run may hold at once, one Lane per Ticket.
  // A positive whole number. Default: 1.
  "lanes": 1,

  // Commands run in the worktree after implement.
  // Default: `npm test` and `npm run typecheck`, whichever package.json defines.
  "checks": ["npm test", "npm run typecheck"],

  // Wall-clock limit for any one Check command; each gets the whole of it.
  // A command killed here is a failed Check and spends the fix budget.
  // Lanes run their Checks at the same time in different worktrees, so a Target
  // whose Checks need a port or a database keeps `lanes` at 1.
  "checkTimeoutMinutes": 15,

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
to start rather than merging unverified code. The triage labels are `init`'s to create; a
Run that finds one missing refuses too.

## Development

Working on the pipeline itself runs it out of this checkout rather than off the global
install:

```bash
npm install
npm run agent-pipeline -- run         # drain the Frontier
npm run agent-pipeline -- ticket 3    # one named Ticket
npm test                              # vitest
npm run typecheck                     # tsc --noEmit
```

The orchestrator depends only on the three ports — `Tracker`, `AgentRunner` and
`Workspace` — and is tested end to end through in-memory fakes. The git-backed
`Workspace` is tested against a real temporary repository. No test spawns `gh` or
`claude`.
