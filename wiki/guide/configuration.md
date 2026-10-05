---
title: Configuration
description: Every field of ticket-runner.json, its default, and what it changes about a Run.
---

# Configuration

A Target should work with no settings at all, so every field is optional and `init` writes the file as `{}`. The file exists for what only the Target can know: which commands prove its code works, how long its CI takes, whether its Checks can share a machine, and what it calls its labels. How many Tickets a machine carries at once is the machine's business, so [`--lanes`](./running.md#lanes) overrides the one setting that is really about the Host.

The file is `ticket-runner.json` at the Target's root. It is plain JSON, read with `JSON.parse`, so it cannot hold comments.

| Field | Default | What it changes |
|---|---|---|
| [`baseBranch`](#basebranch) | GitHub's default branch | The branch Tickets are branched from, rebased onto and merged into |
| [`lanes`](#lanes) | `1` | How many Tickets a Run holds at once |
| [`checks`](#checks) | inferred from `package.json` | The commands the pipeline runs itself to gate a Ticket |
| [`checkTimeoutMinutes`](#checks) | `15` | Wall-clock limit for each Check command |
| [`gates.checks`](#gates) | `true` | Whether a Run may start with no Check at all |
| [`gates.ci`](#gates) | `true` | Whether a pull request with no CI checks may merge |
| [`stages`](#stages) | see below | Model, effort, limits and extra instructions per Stage |
| [`permissionMode`](#permissionmode) | `"auto"` | What every Stage session may do without asking |
| [`ciTimeoutMinutes`](#ci) | `30` | How long a Run waits for a pull request's CI |
| [`ciGraceMinutes`](#ci) | `5` | How long "no checks registered yet" still counts as pending |
| [`labels`](#labels) | the six default names | The label names the pipeline reads and writes |

A file that sets several of them:

```json
{
  "baseBranch": "develop",
  "lanes": 2,
  "checks": ["npm test", "npm run typecheck", "npm run lint"],
  "checkTimeoutMinutes": 20,
  "stages": {
    "implement": { "maxTurns": 400, "extraPrompt": "Run `npm run lint -- --fix` before committing." },
    "verify": { "effort": "max" }
  },
  "ciTimeoutMinutes": 45,
  "labels": { "readyForAgent": "agent-ready" }
}
```

## A file that will not load

The schema is strict. An unknown key, a wrong type or an out-of-range value is refused by name, and so is a file that is not JSON. Every command that reads the file (`init`, `run`, `remove`) exits `2` over it; `stop` never reads it.

```text
Invalid ticket-runner.json: stages: Unrecognized key: "implment". Refused by ticket-runner 0.5.2, so the key may be newer than this install.
```

The second sentence is added only for an unknown key. On a machine with a stale install, a key a newer Version added looks exactly like a typo, so the refusal names the Version that refused it. The file itself carries no Version ([ADR-0007](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0007-a-version-is-cut-by-a-human-and-installs-follow-tags.md)).

## `baseBranch`

- `baseBranch`: string

The [Base branch](https://github.com/jjongs2/ticket-runner/blob/main/CONTEXT.md) is what a Run branches each Ticket from, rebases it onto, targets its pull request at, and pulls the main checkout to after a merge. Without this field it is whatever GitHub calls the repository's default branch, so a Target on `master` needs no setting. It is resolved once at the start of a Run.

## `lanes`

- `lanes`: whole number ≥ 1

How many Tickets a Run holds at once, one per [Lane](https://github.com/jjongs2/ticket-runner/blob/main/CONTEXT.md). `run --lanes <n>` overrides it for one Run. Lanes run their Checks at the same time, each in its own worktree, so a Target whose Checks need a port, a database or anything else they would share keeps this at `1`. Only one Lane at a time is in the Landing (rebase to merge), so more Lanes speed up implement and verify, not merging ([ADR-0005](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0005-landing-is-a-serialized-section.md)).

## `checks`

- `checks`: array of strings
- `checkTimeoutMinutes`: number > 0

A [Check](https://github.com/jjongs2/ticket-runner/blob/main/CONTEXT.md) is a deterministic command the pipeline runs itself, never an agent's opinion. Each one runs through the shell in the Ticket's worktree, after the implement Stage, after a fix Stage and after a resolved rebase conflict. A non-zero exit fails the gate, and the Ticket spends its [Fix budget](https://github.com/jjongs2/ticket-runner/blob/main/CONTEXT.md).

Without this field the pipeline infers `npm test` and `npm run typecheck` from whichever of the `test` and `typecheck` scripts `package.json` defines.

`checkTimeoutMinutes` is one limit for every command, and each command gets the whole of it. A command killed at the limit is a failed Check and spends the Fix budget like any other, because a suite that hangs is a defect in the branch's own code. The fix Stage is told that the Check hung rather than failed.

## `gates`

- `gates.checks`: boolean
- `gates.ci`: boolean

| Setting | When on (the default) | When `false` |
|---|---|---|
| `gates.checks` | A Run with no Check command, configured or inferred, refuses to start | The Run starts anyway, with a warning. Check commands that do exist still run |
| `gates.ci` | A pull request with no CI checks at all is a Hand-off | It merges, with a warning at start and a `⚠️ no checks` row on the Ticket |

Turning `gates.ci` off tolerates only a pull request that has *no* checks. Red CI, CI that times out, and a pull request that conflicts with the Base branch still end the Ticket whatever the gates say.

The refusal `gates.checks` guards against reads:

```text
No Check commands are configured and none could be inferred from package.json. Add them to `checks` in ticket-runner.json, add `test` and `typecheck` scripts to package.json, or set `gates.checks` to false in ticket-runner.json to run without a net.
```

## `stages`

- `stages`: object

Each Stage is one `claude -p` session. `stages` takes an object per Stage, and every key in it is optional:

| Stage | What it does | `maxTurns` | `maxMinutes` |
|---|---|---|---|
| `implement` | Drives `/mattpocock-skills:implement` on the Ticket | `300` | `60` |
| `verify` | Tries to prove the Acceptance Criteria are not met, and returns a Verdict | `80` | `20` |
| `fix` | Mends the one failure that spent the Fix budget | `150` | `40` |
| `conflict` | Resolves the conflict where a rebase stopped | `120` | `30` |

| Key | Type | Default | Passed as |
|---|---|---|---|
| `model` | string | `"claude-opus-5-5"` | `--model` |
| `effort` | `"low"`, `"medium"`, `"high"`, `"xhigh"` or `"max"` | `"high"` | `--effort` |
| `maxTurns` | whole number ≥ 1 | per Stage, above | `--max-turns` |
| `maxMinutes` | number > 0 | per Stage, above | The wall-clock limit the session is killed at |
| `extraPrompt` | string | `""` | Appended as the last section of the Stage's prompt |

The model and effort are always passed, never left to the machine's own defaults, so a Stage's saved command line says exactly what ran it and reruns the same way. What a Stage that runs out of turns or time costs the Ticket is on [From Ticket to merge](./ticket-to-merge.md).

## `permissionMode`

- `permissionMode`: `"auto"`, `"acceptEdits"` or `"bypassPermissions"`

Passed to every Stage as `--permission-mode`. Every Stage also runs with `--permission-prompts none`: nobody is watching, so anything that would prompt is denied instead. The modes on offer are the ones that can do work unattended; `plan` and the prompting modes would guarantee a Stage that does nothing.

## CI

- `ciTimeoutMinutes`: number > 0
- `ciGraceMinutes`: number > 0

After the Landing opens a pull request, the Run waits up to `ciTimeoutMinutes` for its checks. CI that does not finish in time is a Hand-off that spends no Fix budget: it is somebody else's infrastructure, not a defect a fix Stage could mend.

`ciGraceMinutes` covers the gap before GitHub registers a check run, which has taken over three minutes. Until it passes, a pull request with no checks yet counts as pending rather than as having none. It never outlasts `ciTimeoutMinutes`. Raise it on a Target whose Actions queue slowly. A Target with no CI workflow waits it out once per merge, and since only one Lane is in the Landing at a time, that wait holds the other Lanes' merges too.

## `labels`

- `labels`: object of strings

Rename the triage vocabulary when the Target already uses other label strings. Only the keys you give change.

| Key | Default |
|---|---|
| `needsTriage` | `needs-triage` |
| `needsInfo` | `needs-info` |
| `readyForAgent` | `ready-for-agent` |
| `readyForHuman` | `ready-for-human` |
| `wontfix` | `wontfix` |
| `inProgress` | `in-progress` |

`init` creates the labels under these names, and a Run refuses a Target missing any of them. What each label means to the pipeline is on [Planning the work](./planning.md#labels).

## Related pages

- [Running](./running.md): `--lanes` and the Run that reads this file.
- [From Ticket to merge](./ticket-to-merge.md): where each Stage, Check and gate sits in a Ticket's life.
- [Planning the work](./planning.md): the labels and what they mean.
- [Install and remove](./installation.md): `init` writes the empty file; `remove` deletes it last.

## References

- [`src/config.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/config.ts), [`src/ports/agent-runner.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/ports/agent-runner.ts), [`src/startup.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/startup.ts), [`src/base-branch.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/base-branch.ts)
- [`src/orchestrator.ts` · `runChecks`, `requireGreenCi`](https://github.com/jjongs2/ticket-runner/blob/main/src/orchestrator.ts), [`src/prompts.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/prompts.ts), [`src/adapters/claude-agent-runner.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/adapters/claude-agent-runner.ts), [`src/adapters/gh-tracker.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/adapters/gh-tracker.ts), [`src/adapters/git-workspace.ts` · `runCheck`](https://github.com/jjongs2/ticket-runner/blob/main/src/adapters/git-workspace.ts)
- [ADR-0002](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0002-claude-p-child-process-per-stage.md), [ADR-0005](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0005-landing-is-a-serialized-section.md), [ADR-0007](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0007-a-version-is-cut-by-a-human-and-installs-follow-tags.md)
