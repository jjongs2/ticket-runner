# Contributing

Conventions for humans and agents working in this repo. Vocabulary is defined in `CONTEXT.md`; decisions in `docs/adr/`. What the pipeline requires of any Target, this repository included, is in [`docs/agents/pipeline-conventions.md`](docs/agents/pipeline-conventions.md), which `agent-pipeline init` writes; this guide adds what is only ours and points at that document for the rest. Anything a config file or `--help` already answers is left out here on purpose.

## Branches

- `main` receives squash merges from pull requests only. Nobody commits to it directly. Bootstrap exception: Planning documents written before the first Ticket merged landed on `main` directly, because no CI existed to gate a PR.
- `agent/<n>-<slug>` belongs to the pipeline, as the conventions document states. `<slug>` is the Ticket title in lowercase kebab-case, at most 40 characters.
- `version/<number>` carries a Version PR and nothing else.
- `human/<n>-<slug>` for attended work on a Ticket, `human/<slug>` for attended work without one. Create it before running `/implement`, which commits to whatever branch is checked out.
- Branches are updated by rebasing on `main`. Merge commits do not appear in history.
- A branch is deleted when its PR merges. A handed-off Ticket keeps its branch and worktree until a human finishes or abandons it.

## Commits

- Subject shape, and the Ticket number every commit carries: the conventions document. That reference is also how code-review finds the Ticket to grade against. On top of the shape, here: imperative mood, at most 72 characters.
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`.
- Scopes: `cli`, `orchestrator`, `config`, `tracker`, `agent-runner`, `workspace`. Omit the scope when a change spans several.
- Commit early and often on the branch; the PR squashes, so branch history is scratch. Commit work in progress instead of stashing: `refs/stash` is shared across worktrees.
- Keep any `Co-Authored-By` trailers the tooling adds.

## Pull requests

- One PR per Ticket. Attended work too small to be a Ticket — a document, a skill — opens its PR without one: its commits carry no number and its body no `Closes`. The PR title becomes the squash commit subject on `main`, so write it in the commit subject format without the `(#<n>)`.
- A pipeline PR takes its title from the subject of the branch's first commit with that trailing `(#<n>)` removed. When that subject is not in the commit format the Ticket title is used instead, and it is the one subject on `main` allowed not to be: a Stage that could not write one conventional subject is not trusted to have one invented for it, and the Ticket title at least says what the work was. A draft PR the hand-off opens keeps the Ticket title, since nothing of it is merged; a PR that was already open when the hand-off came keeps the title it was opened with.
- Body starts with `Closes #<n>` on its own line so the merge closes the Ticket. For pipeline PRs the Verdict summary follows.
- A draft PR means the Ticket was handed off; the hand-off comment on the Ticket names the branch, and the worktree when there is one. A Ticket handed off before its worktree was created has neither: nothing was branched, so there is nothing to push and no draft PR to open. A Ticket handed off at setup because its branch was already checked out somewhere names that worktree but gets no draft PR either: the work in it is a human's, and no Stage of the Run ran there. Nor does a resumed Ticket handed off at setup because its branch here has parted from the one on the remote: pushing either over the other is the human's call.
- Merge when CI is green: squash, then delete the branch. A PR with no checks is not mergeable.
- A pipeline merge composes the squash commit itself instead of taking GitHub's default: the PR title with ` (#<pr>)` appended as the subject, then `Closes #<n>`, the Verdict line, one line per branch commit subject, and the branch's unique `Co-authored-by` trailers. `docs/templates/squash-commit.txt` is the shape. GitHub uses an explicit subject and body verbatim, so everything its default message would have added is added here; a human merging by hand takes the default, which gives the same result.

## Versions

- A **Version PR** reaches `main` without a Ticket number (ADR-0007). Its branch is `version/<number>`, its title and commit subject are `chore: version <number>`, and it carries nothing but the two numbers, the Version's `CHANGELOG.md` section and the mark on our own copy of the conventions document, which `npx tsx scripts/version.ts mark` rewrites.
- The number is minor when a Spec has closed since the last Version and patch for everything that shipped between two Specs, whatever its type — a small feature as much as a fix. Did a Spec close, yes or no, is the whole rule; work that deserves a minor deserves a Spec.
- `/cut-a-version` ([`.claude/skills/cut-a-version/`](.claude/skills/cut-a-version/SKILL.md)) drafts the pull request: the number, the section in the shape [`docs/templates/version-notes.md`](docs/templates/version-notes.md) gives, and both numbers raised together. It never merges — the review and the merge are the maintainer's, and they are what cuts the Version.
- The check on the pull request refuses a number that is not above every tag, a lock file that disagrees and a missing or incomplete section. The push to `main` tags the commit `v<number>` and publishes the section as that Version's GitHub Release.

## Issues

Two kinds of issue exist, and the difference matters to the pipeline:

- A **Spec** (from `/to-spec`) describes a whole feature. It carries no state label. Tell `/to-spec` to skip `ready-for-agent`, or remove the label right after `/to-tickets` runs.
- A **Ticket** (from `/to-tickets` or `/triage`) is one agent session of work. It has `- [ ]` Acceptance Criteria in its body or a comment, is a native sub-issue of its Spec when it has one, and declares blockers with native `blocked by` edges (`gh issue create --parent <spec> --blocked-by <n,n>`). The body's `Blocked by` section is a human-readable copy, never the source of truth (ADR-0003).

Labels are the triage state machine in `docs/agents/triage-labels.md`: one state label per issue at a time. `in-progress` is set only by a Run. Tickets from `/to-tickets` skip triage; they arrive `ready-for-agent`.

Write issue titles in the glossary's words and keep them short. Describe behaviour, never file paths.

## Templates

- `.github/PULL_REQUEST_TEMPLATE.md` is what GitHub applies to hand-written PRs.
- `docs/templates/` holds the exact shapes the pipeline writes: progress and hand-off comments, guard warnings, [Note comments](docs/templates/note-comment.md) and the [standing issue Notes are gathered on](docs/templates/notes-issue.md), PR bodies, the Run summary, and the [Operator's skill](docs/templates/operator-skill.md) `init` writes into a Target, the one shape the package carries as a file rather than embedding. It also holds the one shape no code writes, the [Version notes](docs/templates/version-notes.md) a Version PR carries. Change a shape there before changing the code that writes it.

## Worktrees and local state

- Pipeline worktrees live under `.worktrees/ticket-<n>`; Run logs under `.agent-pipeline/`. Both directories are gitignored and safe to delete when no Run is running: a Ticket's work is on its branch on the remote, pushed after every committing Stage, and a worktree deleted here is made again from it.
- A Ticket's resume state lives on the Target's remote, not in the checkout: `ticket-<n>.json` on the `agent-pipeline/state` branch, with a handed-off Ticket's Stage transcripts under `ticket-<n>/` beside it, which the pipeline rewrites as a single snapshot commit and force-pushes with a lease (ADR-0004). A Ticket keeps that file from the Claim until its branch carries nothing left to resume — it merges, its issue closes, its branch is in neither its worktree here nor on the remote, or it is handed off at setup over a branch no Stage of the Run worked on — so it is also what a Run killed mid-Ticket, and a Ticket handed to a human, leave behind for the next Run on any Host. Never commit to that branch by hand while a Run is running.
- The Run lock lives on the Target's remote too, as `lock.json` on the `agent-pipeline/lock` branch, which always exists once a Run has started: each take and release is a commit on the tip it read, pushed with a lease on that tip, and nothing is ever deleted from it (ADR-0008). A Run takes over a lock only when it names a Run on the same Host whose process has gone. The one commit a human makes there is a `lock.json` reading `{ "held": false }`, to release a lock a Run on another Host left behind, and only when no Run is running.
- Attended work also happens in a worktree when a Run may be active, so the main checkout stays clean for the pipeline to pull.

## Code

- TypeScript, strict, ESM. Tests are vitest files named `*.test.ts` beside the code they test.
- The orchestrator depends on the three ports (`Tracker`, `AgentRunner`, `Workspace`) as interfaces. Adapters are thin: argument building and output parsing.
- Tests reach the orchestrator through in-memory fakes of the ports. The git-backed `Workspace` is tested against a real temporary repository. Tests never spawn `gh` or `claude`.
- Every external effect goes through a port, the pipeline's own state included: the Run lock and a Ticket's State go through `Workspace` like every other external effect (ADR-0004), so the tests that reach them use the in-memory fake rather than a temporary repo root.
- `scripts/` is this repository's own plumbing, what a workflow runs and no install carries. It stays thin: the judgement it needs is a module in `src/`, where the tests are.
- Name things with the glossary. A concept that needs a new word is a signal to update `CONTEXT.md` first.

## Language

Repo documents, issues, commits and code comments are in English so every agent session reads one vocabulary. Conversation with the maintainer is in Korean.
