# Contributing

Conventions for humans and agents working in this repo. Vocabulary is defined in `CONTEXT.md`; decisions in `docs/adr/`. Anything a config file or `--help` already answers is left out here on purpose.

## Branches

- `main` receives squash merges from pull requests only. Nobody commits to it directly. Bootstrap exception: Planning documents written before the first Ticket merged landed on `main` directly, because no CI existed to gate a PR.
- `agent/<n>-<slug>` is reserved for pipeline Runs. `<n>` is the Ticket number, `<slug>` is the Ticket title in lowercase kebab-case, at most 40 characters.
- `human/<n>-<slug>` for attended work on a Ticket. Create it before running `/implement`, which commits to whatever branch is checked out.
- Branches are updated by rebasing on `main`. Merge commits do not appear in history.
- A branch is deleted when its PR merges. A handed-off Ticket keeps its branch and worktree until a human finishes or abandons it.

## Commits

- Subject: `<type>(<scope>): <summary> (#<n>)`. Imperative mood, at most 72 characters.
- `<n>` is the Ticket number. The `#<n>` reference is how code-review finds the Ticket to grade against, so it appears on every commit.
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`.
- Scopes: `cli`, `orchestrator`, `config`, `tracker`, `agent-runner`, `workspace`. Omit the scope when a change spans several.
- Commit early and often on the branch; the PR squashes, so branch history is scratch. Commit work in progress instead of stashing: `refs/stash` is shared across worktrees.
- Keep any `Co-Authored-By` trailers the tooling adds.

## Pull requests

- One PR per Ticket. The PR title becomes the squash commit subject on `main`, so write it in the commit subject format without the `(#<n>)`.
- A pipeline PR takes its title from the subject of the branch's first commit with that trailing `(#<n>)` removed. When that subject is not in the commit format the Ticket title is used instead, and it is the one subject on `main` allowed not to be: a Stage that could not write one conventional subject is not trusted to have one invented for it, and the Ticket title at least says what the work was. A draft PR the hand-off opens keeps the Ticket title, since nothing of it is merged; a PR that was already open when the hand-off came keeps the title it was opened with.
- Body starts with `Closes #<n>` on its own line so the merge closes the Ticket. For pipeline PRs the Verdict summary follows.
- A draft PR means the Ticket was handed off; the hand-off comment on the Ticket names the branch and worktree.
- Merge when CI is green: squash, then delete the branch. A PR with no checks is not mergeable.
- A pipeline merge composes the squash commit itself instead of taking GitHub's default: the PR title with ` (#<pr>)` appended as the subject, then `Closes #<n>`, the Verdict line, one line per branch commit subject, and the branch's unique `Co-authored-by` trailers. `docs/templates/squash-commit.txt` is the shape. GitHub uses an explicit subject and body verbatim, so everything its default message would have added is added here; a human merging by hand takes the default, which gives the same result.

## Issues

Two kinds of issue exist, and the difference matters to the pipeline:

- A **Spec** (from `/to-spec`) describes a whole feature. It carries no state label. Tell `/to-spec` to skip `ready-for-agent`, or remove the label right after `/to-tickets` runs.
- A **Ticket** (from `/to-tickets` or `/triage`) is one agent session of work. It has `- [ ]` Acceptance Criteria in its body or a comment, is a native sub-issue of its Spec when it has one, and declares blockers with native `blocked by` edges (`gh issue create --parent <spec> --blocked-by <n,n>`). The body's `Blocked by` section is a human-readable copy, never the source of truth (ADR-0003).

Labels are the triage state machine in `docs/agents/triage-labels.md`: one state label per issue at a time. `in-progress` is set only by a Run. Tickets from `/to-tickets` skip triage; they arrive `ready-for-agent`.

Write issue titles in the glossary's words and keep them short. Describe behaviour, never file paths.

## Templates

- `.github/PULL_REQUEST_TEMPLATE.md` is what GitHub applies to hand-written PRs.
- `docs/templates/` holds the exact shapes the pipeline writes: progress and hand-off comments, guard warnings, PR bodies, the Run summary. Change a shape there before changing the code that writes it.

## Worktrees and local state

- Pipeline worktrees live under `.worktrees/ticket-<n>`; Run logs and state under `.agent-pipeline/`, where a released Ticket's resume state is `.agent-pipeline/state/ticket-<n>.json` (ADR-0004). Both are gitignored and safe to delete when no Ticket is handed off or resumable.
- Attended work also happens in a worktree when a Run may be active, so the main checkout stays clean for the pipeline to pull.

## Code

- TypeScript, strict, ESM. Tests are vitest files named `*.test.ts` beside the code they test.
- The orchestrator depends on the three ports (`Tracker`, `AgentRunner`, `Workspace`) as interfaces. Adapters are thin: argument building and output parsing.
- Tests reach the orchestrator through in-memory fakes of the ports. The git-backed `Workspace` is tested against a real temporary repository. Tests never spawn `gh` or `claude`.
- Name things with the glossary. A concept that needs a new word is a signal to update `CONTEXT.md` first.

## Language

Repo documents, issues, commits and code comments are in English so every agent session reads one vocabulary. Conversation with the maintainer is in Korean.
