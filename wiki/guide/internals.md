---
title: Internals
description: The three ports and their adapters, a map of the modules in src/, how Versions are cut and stamped, the ADRs in brief, and how to work on the pipeline itself.
---

# Internals

The pipeline touches three things outside itself: GitHub, Claude and git. Each is reached through a port, an interface the orchestrator depends on, so the whole unattended flow can be tested in memory, with no subscription spent and nothing written to GitHub. The adapters behind the ports are kept thin. They build arguments and parse output; decisions live in the modules above them.

This page is for reading the source or changing it. To use the pipeline, start at [Installation](./installation.md).

## At a glance

| Port | The effect it isolates | Adapter · fake for tests |
|---|---|---|
| `Tracker` | GitHub: issues, labels, comments, pull requests, CI, merges | `GhTracker` · `FakeTracker` |
| `AgentRunner` | Claude: one Stage session | `ClaudeAgentRunner` · `FakeAgentRunner` |
| `Workspace` | git: worktrees, Checks, rebase, push, the State and the Run lock | `GitWorkspace` · `FakeWorkspace` |

```mermaid
flowchart LR
    subgraph Entry
        CLI["cli.ts"] --> START["start.ts: readiness, lock, summary"]
    end
    subgraph Core["Run and Ticket logic"]
        RUN["run.ts: Lanes, sweep, Frontier"] --> ORCH["orchestrator.ts: one Ticket"]
    end
    subgraph Ports
        T["Tracker"]
        A["AgentRunner"]
        W["Workspace"]
    end
    START --> RUN
    ORCH --> T
    ORCH --> A
    ORCH --> W
    T -.-> GH["GhTracker → gh api → GitHub"]
    A -.-> CL["ClaudeAgentRunner → claude -p"]
    W -.-> GIT["GitWorkspace → git, origin"]
```
<!-- Sources: src/cli.ts, src/start.ts, src/run.ts, src/orchestrator.ts, src/ports/tracker.ts, src/ports/agent-runner.ts, src/ports/workspace.ts -->

The CLI is the only place that constructs adapters. Everything under `start.ts` receives them as interfaces.

## The adapters

### `GhTracker`

[`GhTracker`](https://github.com/jjongs2/ticket-runner/blob/main/src/adapters/gh-tracker.ts) makes every GitHub call, through `gh api`.

- It speaks REST on every Host, because a cloud Host refuses GraphQL outright.
- The one exception is moving a pull request into or out of draft, which REST cannot do. A workstation uses the GraphQL mutation; a cloud Host uses the proxy's `/pulls/{n}/ccr/convert_to_draft` and `/ready_for_review` routes.
- It polls CI every 15 seconds.

### `ClaudeAgentRunner`

[`ClaudeAgentRunner`](https://github.com/jjongs2/ticket-runner/blob/main/src/adapters/claude-agent-runner.ts) runs one Stage as one child process, with `--json-schema` only where the Stage answers one:

```text
claude --print <prompt> --output-format stream-json --verbose \
  --permission-prompts none --permission-mode … \
  --model … --effort … --max-turns … [--json-schema …]
```

- It sets `TICKET_RUNNER_STAGE` in the child's environment.
- It writes `<stage>.command`, `.stdout`, `.stderr` and `.transcript.jsonl` from the moment the Stage starts.
- It kills the child at `maxMinutes`, and classifies a failure as `rate-limited`, `timed-out`, `turn-capped`, `nonzero-exit` or `invalid-result`.

### `GitWorkspace`

[`GitWorkspace`](https://github.com/jjongs2/ticket-runner/blob/main/src/adapters/git-workspace.ts) keeps the worktrees under `.worktrees/`, runs the Checks, rebases and pushes, and keeps the `ticket-runner/state` and `ticket-runner/lock` branches ([Stopping and resuming](./stopping-and-resuming.md)).

- Commands in the main checkout run one at a time, because git fails on a held ref or index lock rather than waiting.
- Commands inside a worktree stay parallel.

### Smaller adapters

- [`exec.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/adapters/exec.ts) spawns a child with a timeout and streaming sinks. It reports `timedOut` separately, because a command may exit 124 on its own.
- [`repo-root.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/adapters/repo-root.ts) finds the main checkout, even from inside a worktree, so the lock, `.worktrees/` and the logs land in one place per clone.
- [`version.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/adapters/version.ts) reads which [Version](#versions) this copy is. It is an adapter because it runs git, though no port describes it.

## A map of `src/`

Tests sit beside each module as `*.test.ts`.

**Entry**

| Module | One line |
|---|---|
| [`cli.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/cli.ts) | reads the Version, dispatches `init`, `run`, `stop`, `remove`, `-v`; builds the adapters |
| [`command-line.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/command-line.ts) | parses arguments and holds the usage text, before anything is looked at |
| [`stage-guard.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/stage-guard.ts) | refuses every command inside a Stage's shell (the Stage mark) |
| [`start.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/start.ts) | refusals, the Run lock, the Stop listener, the summary and the exit code |
| [`startup.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/startup.ts) | refuses a Run with nothing to gate a merge; warns about gates turned off |

**Run and Ticket**

| Module | One line |
|---|---|
| [`run.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/run.ts) | fills Lanes from the Stranded Tickets, then the Frontier; stops claiming on a Release or Stop |
| [`orchestrator.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/orchestrator.ts) | one Ticket from guards to merge, Hand-off or Release, with the Fix budget |
| [`frontier.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/frontier.ts) | splits candidates into the Frontier and the blocked |
| [`guards.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/guards.ts) | why a candidate is skipped: the Guards and the refusals |
| [`landing.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/landing.ts) | the Landing: one Lane between rebase and pull at a time, in arrival order |
| [`lifecycle.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/lifecycle.ts) | where a Ticket failed, and which failures a fix Stage may mend |
| [`base-branch.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/base-branch.ts) | resolves the Base branch once per Run |
| [`branch.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/branch.ts) | `agent/<n>-<slug>` and `.worktrees/ticket-<n>` |
| [`stranded.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/stranded.ts) | the sweep for Stranded Tickets |
| [`resume.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/resume.ts) | the State file's shape and name |
| [`handoff.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/handoff.ts) | marks old hand-off comments as history when a Ticket is taken again |
| [`stop.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/stop.ts) | `ticket-runner stop`, and the Run's end of SIGTERM |
| [`lock.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/lock.ts) | what the Run lock file says, and whether its holder is alive |
| [`host.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/host.ts) | workstation or cloud, and which one |

**What Stages are told and what they answer**

| Module | One line |
|---|---|
| [`prompts.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/prompts.ts) | each Stage's prompt, which expands `/mattpocock-skills:<skill>` |
| [`self-hosting.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/self-hosting.ts) | whether the Target is the pipeline's own repository, which decides what a Stage is told about its checkout |
| [`verdict.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/verdict.ts) | the Verdict schema and whether it passes |
| [`title.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/title.ts) | the pull request title from the Stages' answers, then the commits, then the Ticket |
| [`note-schema.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/note-schema.ts), [`notes.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/notes.ts) | Notes: how a Stage declares them and where they are routed |
| [`acceptance-criteria.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/acceptance-criteria.ts), [`criteria.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/criteria.ts) | what a criterion looks like; ticking the `met` ones after a merge |
| [`progress.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/progress.ts) | the one Progress comment per Ticket, edited in place |
| [`templates.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/templates.ts) | every shape written to GitHub, and the Run summary; `docs/templates/` is the source of truth |
| [`run-log.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/run-log.ts) | `.ticket-runner/runs/<runId>/` and what a Hand-off keeps of it |

**Target setup**

| Module | One line |
|---|---|
| [`init.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/init.ts) | `ticket-runner init`: writes, sets up GitHub, reports the rest |
| [`readiness.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/readiness.ts) | Target readiness, which `init` provides and `run` checks |
| [`conventions.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/conventions.ts) | the conventions document's text and its Version mark |
| [`operator-skill.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/operator-skill.ts) | the Operator's skill `init` writes into a Target |
| [`labels.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/labels.ts) | the six triage labels and their colours |
| [`config.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/config.ts) | `ticket-runner.json`: schema and defaults |
| [`remove.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/remove.ts) | `ticket-runner remove` |

**Versions**

| Module | One line |
|---|---|
| [`version-number.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/version-number.ts) | number comparison, shared by every Version question |
| [`staleness.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/staleness.ts) | the newer-Version line and the conventions-document warning |
| [`version-pr.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/version-pr.ts) | what a Version PR must get right; the notes a Release publishes |

**Tests only**: [`testing/`](https://github.com/jjongs2/ticket-runner/blob/main/src/testing/fakes.ts) holds the fakes and helpers described next.

## How the orchestrator is tested

No test spawns `gh` or `claude`. Each layer is tested at the seam that suits it.

| Layer | Tested against |
|---|---|
| `orchestrator.ts`, `run.ts`, `start.ts`, `stranded.ts` … | in-memory fakes of all three ports |
| Lanes running side by side | the fakes, plus `Hold` and `settle` |
| `GitWorkspace` | real git: a temporary repository with a bare remote |
| `GhTracker`, `ClaudeAgentRunner` | recorded runs, through their `run` seam |

- Each fake keeps an ordered `calls` log. Tests assert on it and on the resulting state, never on internal helpers. `FakeWorkspace` keeps the State and the lock in memory, and can play `THIS_HOST` or `ANOTHER_HOST`.
- A `Hold` parks a Ticket at a chosen point, inside a Stage or a CI wait, until the test lets it go, so what another Lane does meanwhile can be observed.
- The `GitWorkspace` tests run worktrees, rebases, leases and the state and lock branches for real.
- For the other two adapters, `testing/executions.ts` builds the `Execution` a process would have returned.

This is why every external effect goes through a port, the pipeline's own bookkeeping included: State and the lock are effects on the remote, so they are `Workspace` methods and the fakes cover them ([ADR-0004](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0004-resume-state-lives-on-the-targets-remote.md), last amendment).

## Versions

Without Versions, two installs could report the same number and run code weeks apart, so a bug read off a transcript could not be tied to a commit, and a stale install showed only when a Target behaved like last week's pipeline. Nothing the pipeline left in a Target said which pipeline wrote it either, so two machines on different installs rewrote the same conventions document back and forth.

A [Version](https://github.com/jjongs2/ticket-runner/blob/main/CONTEXT.md) is a number that `main` carries as a tag `v<x.y.z>`, with a GitHub Release. An installed copy reports it. Machines install a Version, never `main`, so two machines that report `0.5.2` run the same code ([ADR-0007](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0007-a-version-is-cut-by-a-human-and-installs-follow-tags.md)).

### How one is cut

```mermaid
flowchart LR
    SK["/cut-a-version drafts the Version PR"] --> PR["version/‹number› · chore: version ‹number›"]
    PR --> CK{"version-pr.yml check"}
    CK -- refused --> PR
    CK -- passes --> MG["human reviews and merges"]
    MG --> TG["version-tag.yml: tag v‹number›"]
    TG --> RL["GitHub Release, body = the CHANGELOG section"]
```
<!-- Sources: src/version-pr.ts, scripts/version.ts, .github/workflows/version-pr.yml, .github/workflows/version-tag.yml -->

- **The number.** It goes up by a minor when a Spec has closed since the last Version, and by a patch for everything else, a small feature included. The only question is whether a Spec closed. A human decides when to cut, because that is a Planning decision.
- **The Version PR.** It raises `package.json` and the lock file, adds the Version's section to `CHANGELOG.md`, and re-marks this repository's own conventions document with `npx tsx scripts/version.ts mark`. The [`/cut-a-version`](https://github.com/jjongs2/ticket-runner/blob/main/.claude/skills/cut-a-version/SKILL.md) skill drafts it; it never merges.
- **The check** lists every reason at once: the number is not above every tag, the lock file disagrees, the section is missing, or the section has no `### After upgrading` heading. A pull request that leaves the number alone passes untouched.
- **The tag workflow** tags the merge commit and publishes the section as the Release, or GitHub's generated notes if the section is missing. It finishes whichever half is missing, so a re-run heals a half-cut Version.

release-please and Changesets were both turned down. The first needed a yearly-expiring token, a repository setting and a rule that only `feat`/`fix` cut a Version. The second would have put a changeset file into every Stage's job.

### The stamp

The Version is resolved once, in the CLI, and handed down. Every stamp one Run writes is therefore the same string.

| `-v` prints | When |
|---|---|
| `0.5.2` | an installed copy: the number is the whole of it |
| `0.5.2+331d79c` | a development checkout, clean |
| `0.5.2+331d79c.dirty` | a development checkout with uncommitted changes |
| `unknown` | no readable `package.json` |

The same string is stamped on:

| Where | So that |
|---|---|
| the Run summary's header, the `init` report's first line | a terminal says which pipeline ran |
| each Run's section of a Progress comment | the board says which pipeline wrote it |
| each State file's `version` | an unreadable file can still name what wrote it |
| `version.txt` in the Run's directory | a transcript sits beside the pipeline that wrote it |
| the conventions document's first line (the number only) | `init` and a Run can tell which side is behind |
| the refusal of a config key the install does not know | a stale install is told apart from a wrong config |

The summary's header reads `ticket-runner <version> run <runId> · <n>m`. The file is `.ticket-runner/runs/<runId>/version.txt`, and a Hand-off keeps it with the transcripts.

The conventions document's mark, `<!-- ticket-runner:version <number> -->`, has a direction. An older pipeline leaves a newer document alone and asks to be upgraded. A Run behind the document warns, and a Run ahead of it names `init`. Neither ever refuses.

### The newer-Version check

A Run and `init` each look up the highest published Version of the pipeline's own repository. They read it from `package.json`'s `repository` field, so a fork asks about itself. The lookup reads GitHub Releases, skipping drafts and prereleases, because a tag whose Release is not out yet is not installable. Only numbers are compared, so a checkout running past the latest Version is not stale.

When a newer one is out, [`staleness.ts` · `newerVersionLine`](https://github.com/jjongs2/ticket-runner/blob/main/src/staleness.ts) prints one line, at the top of the Run log and again at the head of the summary:

```
A newer Version is out: 0.6.0, and this is 0.5.2 — upgrade with `npm install -g "github:jjongs2/ticket-runner#semver:*"`.
```

A lookup that cannot be made (no network, no `gh`, a repository nobody can see) prints nothing. Nothing is ever refused over it.

Install and upgrade with `npm install -g ticket-runner`, or try it through `npx` without one ([Try it without installing](./installation.md#try-it-without-installing)). The GitHub tag range the message names, `npm install -g "github:jjongs2/ticket-runner#semver:*"`, also installs the highest Version tag. See [Installation](./installation.md).

## The ADRs in brief

The full records are in [`docs/adr/`](https://github.com/jjongs2/ticket-runner/tree/main/docs/adr). Several have amendments; this is where they stand now.

### [ADR-0001: Humans plan, the pipeline executes](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0001-humans-plan-the-pipeline-executes.md) {#adr-0001}

- **Decision**: Humans plan; only Execution is unattended.
- **Why**: A wrong answer to a grilling question hardens into a Spec, Tickets and merged code with no gate left.
- **Cost**: Planning quality is a human's job; the pipeline only guards against known defects.

### [ADR-0002: One `claude -p` child process per Stage](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0002-claude-p-child-process-per-stage.md) {#adr-0002}

- **Decision**: Each Stage is its own `claude -p` child process.
- **Why**: Only headless mode expands a user-invoked `/plugin:skill`. A process also gives per-Stage limits, `--json-schema`, and a command line to replay.
- **Cost**: One to two seconds of startup per Stage. No shared context, so each Stage reads the Ticket and the branch.

### [ADR-0003: Trust only GitHub-native issue relations](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0003-github-native-relations-only.md) {#adr-0003}

- **Decision**: Only GitHub-native blockers and sub-issues count.
- **Why**: Two sources of truth would let a stale body silently block or unblock work.
- **Cost**: Humans must create the native edges; blockers named only in a body are skipped with a warning.

### [ADR-0004: Resume state lives on the Target's remote, not in a tracker comment](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0004-resume-state-lives-on-the-targets-remote.md) {#adr-0004}

- **Decision**: Resume state is a State file kept off the board, now on the Target's remote. A Hand-off keeps it too.
- **Why**: The board is for humans. A cloud Host is discarded, so the state must outlive it. A relabel should resume a Ticket.
- **Cost**: No migration of old local State; the State branch goes through `Workspace`.

### [ADR-0005: Landing is a serialized section, not a merge queue](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0005-landing-is-a-serialized-section.md) {#adr-0005}

- **Decision**: The Landing is a section one Lane is in at a time, not a merge queue.
- **Why**: What CI graded is exactly what lands, without paying for CI twice. GitHub's merge queue would have made a repository setting part of Target readiness.
- **Cost**: One slow CI or Conflict Stage holds every other Lane's Landing.

### [ADR-0006: Stop is a signal, and Ctrl+C stays a kill](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0006-stop-is-a-signal-and-ctrl-c-is-a-kill.md) {#adr-0006}

- **Decision**: A Stop is SIGTERM and nothing else, sent only from the Run's own Host; Ctrl+C stays a kill.
- **Why**: A signal arrives at once and leaves nothing to clean up. The Stages share the Run's process group.
- **Cost**: A Stop cannot be taken back, and a Run on another Host cannot be stopped from here.

### [ADR-0007: A Version is cut by a human, and installs follow tags](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0007-a-version-is-cut-by-a-human-and-installs-follow-tags.md) {#adr-0007}

- **Decision**: A human cuts a Version by merging a Version PR; installs follow tags.
- **Why**: When to cut is a Planning decision. A number is only a useful stamp if two machines with it run the same code.
- **Cost**: Version notes are written by hand, with an agent's help.

### [ADR-0008: A cloud Host is a Claude Code cloud session, and the Run lock lives on GitHub](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0008-a-cloud-host-is-a-claude-code-cloud-session.md) {#adr-0008}

- **Decision**: A cloud Host is a Claude Code cloud session with an Operator; the Run lock lives on GitHub.
- **Why**: No Actions minutes, and a Run steered from the app. Every Host must see the lock.
- **Cost**: REST only. Nothing on the remote may depend on deleting a ref. A lock from a vanished Host needs a human to release it.

## Working on the pipeline itself

To change the pipeline, run it from a checkout. `bin/ticket-runner.js` loads the TypeScript through `tsx`, so there is no build step:

```bash
git clone https://github.com/jjongs2/ticket-runner && cd ticket-runner
npm install
npm run ticket-runner -- run         # drain this repository's Frontier
npm run ticket-runner -- run 3 7     # a Run narrowed to #3 and #7
npm test                             # vitest
npm run typecheck                    # tsc --noEmit
```

A checkout reports its commit beside the number (see [the stamp](#the-stamp)). CI runs `npm run typecheck` and `npm test` on every pull request, and the Version PR check beside them.

This repository is a Target of its own pipeline, so it follows the same rules as any other Target. Read these before committing, not a copy here:

- [`CONTRIBUTING.md`](https://github.com/jjongs2/ticket-runner/blob/main/CONTRIBUTING.md): branches, commits, pull requests, Version PRs, issues, and code rules (strict ESM TypeScript, tests beside the code, every effect through a port, `scripts/` kept thin)
- [`docs/agents/pipeline-conventions.md`](https://github.com/jjongs2/ticket-runner/blob/main/docs/agents/pipeline-conventions.md): what the pipeline requires of any Target
- [`CONTEXT.md`](https://github.com/jjongs2/ticket-runner/blob/main/CONTEXT.md): name things with the glossary; a concept that needs a new word goes there first
- [`docs/templates/`](https://github.com/jjongs2/ticket-runner/tree/main/docs/templates): change a shape there before the code that writes it

A Stage may not run the pipeline. Its shell carries `TICKET_RUNNER_STAGE`, and every command refuses while it is set, leaving the pipeline to the Run that started it. In this repository, a Stage's prompt also tells it to exercise the pipeline through the tests and fakes instead.

## Related pages

- [Stopping and resuming](./stopping-and-resuming.md): the State branch and the Run lock that `GitWorkspace` keeps
- [From Ticket to merge](./ticket-to-merge.md): the lifecycle `orchestrator.ts` drives
- [Running](./running.md): the commands `cli.ts` dispatches, and `-v`
- [Installation](./installation.md): installing a Version, `init`, and `remove`

## References

- [`src/ports/`](https://github.com/jjongs2/ticket-runner/tree/main/src/ports), [`src/adapters/`](https://github.com/jjongs2/ticket-runner/tree/main/src/adapters), [`src/testing/`](https://github.com/jjongs2/ticket-runner/tree/main/src/testing)
- [`src/cli.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/cli.ts), [`src/start.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/start.ts), [`src/run.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/run.ts), [`src/orchestrator.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/orchestrator.ts)
- [`src/adapters/version.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/adapters/version.ts), [`src/version-number.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/version-number.ts), [`src/version-pr.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/version-pr.ts), [`src/staleness.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/staleness.ts)
- [`scripts/version.ts`](https://github.com/jjongs2/ticket-runner/blob/main/scripts/version.ts), [`.github/workflows/`](https://github.com/jjongs2/ticket-runner/tree/main/.github/workflows)
- [`CONTRIBUTING.md`](https://github.com/jjongs2/ticket-runner/blob/main/CONTRIBUTING.md), [`CHANGELOG.md`](https://github.com/jjongs2/ticket-runner/blob/main/CHANGELOG.md)
- [ADR-0001](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0001-humans-plan-the-pipeline-executes.md) to [ADR-0008](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0008-a-cloud-host-is-a-claude-code-cloud-session.md)
