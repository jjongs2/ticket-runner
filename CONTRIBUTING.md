# Contributing

Conventions for humans and agents working in this repo. Vocabulary is defined in `GLOSSARY.md`; decisions in `docs/adr/`. What the pipeline requires of any Target, this repository included, is in [`docs/agents/pipeline-conventions.md`](docs/agents/pipeline-conventions.md), which `ticket-runner init` writes; this guide adds what is only ours and points at that document for the rest. Anything a config file or `--help` already answers is left out here on purpose.

## Branches

- `main` receives squash merges from pull requests only. Nobody commits to it directly. Bootstrap exception: Planning documents written before the first Ticket merged landed on `main` directly, because no CI existed to gate a pull request.
- `agent/<n>-<slug>` belongs to the pipeline, as the conventions document states. `<slug>` is the Ticket title in lowercase kebab-case, at most 40 characters.
- `version/<number>` carries a release PR and nothing else.
- `dependabot/…` belongs to Dependabot, which `.github/dependabot.yml` configures and which rebases the branch itself. Nobody commits to it: a commit by hand stops Dependabot from rebasing it.
  - One exception: when the lock file diff changes the version of a package an `allowScripts` field names (today `esbuild`, in both `package.json` and `wiki/package.json`), the same pull request updates that entry, for example with `npm install-scripts approve <package>`. CI's npm ignores `allowScripts`, so CI passes either way, and a local npm 12 or later then blocks that package's install script with only a warning, so nothing else catches it.
  - Its body carries no `Closes`, and its title stays as Dependabot wrote it, even past 72 characters. Like the release PR, it is work no Ticket asked for.
  - A human squash-merges it once CI is green, as any pull request. There is no auto-merge.
  - A major is merged once CI is green and its release notes show nothing CI cannot see, such as a runtime behaviour change or a new Node requirement. A major that fails CI is closed: Dependabot drops that version, a later release comes back to be judged again, and an upgrade that needs work becomes a Ticket.
  - A dependency or update never wanted goes into `ignore` in `dependabot.yml`, never an `@dependabot ignore` comment, which keeps the choice outside the repository. An `ignore` entry silences that dependency's security updates too.
- `human/<n>-<slug>` for attended work on a Ticket, `human/<slug>` for attended work without one. Create it before running `/implement`, which commits to whatever branch is checked out.
- Branches are updated by rebasing on `main`. Merge commits do not appear in history.
- A branch is deleted when its pull request merges. A handed-off Ticket keeps its branch and worktree until a human finishes or abandons it.

## Commits

- Subject shape: the conventions document. On top of the shape, here: imperative mood, at most 72 characters.
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`.
- Scopes: `cli`, `orchestrator`, `config`, `tracker`, `agent-runner`, `workspace`, and `deps` and `deps-dev`, which Dependabot writes. Omit the scope when a change spans several.
- Commit early and often on the branch; the pull request squashes, so branch history is scratch. Commit work in progress instead of stashing: `refs/stash` is shared across worktrees.
- Keep any `Co-Authored-By` trailers the tooling adds.

## Pull requests

- One pull request per Ticket. Attended work too small to be a Ticket — a document, a skill — opens its pull request without one: its body carries no `Closes`. The pull request title becomes the squash commit subject on `main`, so write it in the commit subject format.
- A pipeline pull request takes its title from the `title` the implement and fix Stages answer for the whole branch: the latest one in the commit format, the one the Ticket's state file recorded when a Run resumes after the Stage that answered it, and the one on a pull request already open is updated to match. With no such title it falls back to the subject of the branch's first commit with a trailing `(#<n>)` removed, and when that subject is not in the commit format either, to the Ticket title. The Ticket title is the one subject on `main` allowed not to be in the format: a branch nothing wrote one conventional line about is not trusted to have one invented for it, and the Ticket title at least says what the work was. A draft pull request the hand-off opens takes the title the Ticket's state file holds, since a human can still merge it, and the Ticket title when the state file holds none; a pull request that was already open when the hand-off came keeps the title it was last given.
- Body starts with `Closes #<n>` on its own line so the merge closes the Ticket. For pipeline pull requests the verdict summary follows.
- A draft pull request means the Ticket was handed off; the hand-off comment on the Ticket names the branch, and the worktree when there is one. A Ticket handed off before its worktree was created has neither: nothing was branched, so there is nothing to push and no draft pull request to open. A Ticket handed off at setup because its branch was already checked out somewhere names that worktree but gets no draft pull request either: the work in it is a human's, and no Stage of the Run ran there. Nor does a resumed Ticket handed off at setup because its branch here has parted from the one on the remote: pushing either over the other is the human's call.
- Merge when CI is green: squash, then delete the branch. A pull request with no checks is not mergeable.
- A pipeline merge composes the squash commit itself instead of taking GitHub's default: the pull request title with ` (#<pr>)` appended as the subject, then `Closes #<n>`, the verdict line, one line per branch commit subject, and the branch's unique `Co-authored-by` trailers. `docs/templates/squash-commit.txt` is the shape. GitHub uses an explicit subject and body verbatim, so everything its default message would have added is added here; a human merging by hand takes the default, which gives the same result.

## Versions

- A **release PR** reaches `main` without a Ticket number (ADR-0007). Its branch is `version/<number>`, its title and commit subject are `chore: version <number>`, and it carries nothing but the two numbers, the version's `CHANGELOG.md` section and the mark on our own copy of the conventions document, which `npx tsx scripts/version.ts mark` rewrites.
- The number is minor when a Spec has closed since the last version and patch for everything that shipped between two Specs, whatever its type — a small feature as much as a fix. Did a Spec close, yes or no, is the whole rule; work that deserves a minor deserves a Spec.
- `/cut-a-version` ([`.claude/skills/cut-a-version/`](.claude/skills/cut-a-version/SKILL.md)) drafts the pull request: the number, the section in the shape [`docs/templates/version-notes.md`](docs/templates/version-notes.md) gives, and both numbers raised together. It never merges — the review and the merge are the maintainer's, and they are what cuts the version.
- The check on the pull request refuses a number that is not above every tag, a lock file that disagrees and a missing or incomplete section. The push to `main` tags the commit `v<number>`, publishes the tagged commit to npm by trusted publishing, and then publishes the section as that version's GitHub Release (ADR-0007).

## Issues

Two kinds of issue exist, and the difference matters to the pipeline:

- A **Spec** (from `/to-spec`) describes a whole feature. It carries no state label. Tell `/to-spec` to skip `ready-for-agent`, or remove the label right after `/to-tickets` runs.
- A **Ticket** (from `/to-tickets` or `/triage`) is one agent session of work. It has `- [ ]` Acceptance Criteria in its body or a comment, is a native sub-issue of its Spec when it has one, and declares blockers with native `blocked by` edges (`gh issue create --parent <spec> --blocked-by <n,n>`). The body's `Blocked by` section is a human-readable copy, never the source of truth (ADR-0003).

Labels are the triage state machine in `docs/agents/triage-labels.md`: one state label per issue at a time. `in-progress` is set only by a Run. Tickets from `/to-tickets` skip triage; they arrive `ready-for-agent`.

Write issue titles in the glossary's words and keep them short. Describe behaviour, never file paths.

## Templates

- `docs/templates/` holds the exact shapes the pipeline writes: progress and hand-off comments, guard warnings, [Note comments](docs/templates/note-comment.md) and the [standing issue Notes are gathered on](docs/templates/notes-issue.md), pull request bodies, the Run summary, and the [Operator's skill](docs/templates/operator-skill.md) `init` writes into a Target, the one shape the package carries as a file rather than embedding. It also holds the one shape no code writes, the [release notes](docs/templates/version-notes.md) a release PR carries. Change a shape there before changing the code that writes it.

## README

- `README.md` is for someone who has never seen the pipeline and is deciding in a few minutes whether it fits. Anything deeper goes in the wiki, and the README links the page by its full URL.
- `README.ko.md` translates it into Korean, saying the same things in the same order. `README.md` is the source: a change lands there first and is carried into `README.ko.md` in the same pull request.
- Every link in either is a full URL, because the npm page shows `README.md` alone and cannot follow a relative one.
- `README.md` links a wiki page by its neutral URL, which opens it in the reader's language, and `README.ko.md` by its `/ko/` URL.

## Wiki

- `wiki/` is the project wiki, a VitePress site that `.github/workflows/wiki.yml` builds on every pull request touching it and deploys to GitHub Pages from `main`. It explains the pipeline in more depth than the README, for someone who does not read the source.
- The English pages, in `wiki/en/`, are the source. `wiki/ko/` translates each of them into Korean, in the same order and with the same headings, and a change lands in both in the same pull request.
- Every page has three URLs: `/en/…` and `/ko/…`, which never redirect, and a language-neutral one without a prefix, which the build generates from the page list and which sends the reader to the language they last picked from the language menu, else to Korean when their browser ranks it above English, else to English. Only the neutral URL picks, because a link that names a language is followed by someone who chose it (Google advises against redirecting between language versions); the wiki's own pages never link a neutral URL.
- It is regenerated by hand when behaviour it describes has changed, not with each version. Where it and the code disagree, the code is right. Its reader does not read the source, so the prose cites none; each page ends with a References list of the files it drew on, and only the internals page, whose subject is the modules, links them in its body.
- Each fact is told once, on its home, and other pages link it. A term's home is `GLOSSARY.md`, which a page glosses in a few words where it first uses the term; a decision's reasons and history are its ADR's, summarised in the internals page's ADRs in brief; a mechanism's is the one page whose subject it is. Beside the link, a page keeps only the line its own reader acts on.
- `GLOSSARY.md` says what each term is and where it ends, never how the pipeline does it. How it does it is the code's, and the page whose subject is that mechanism is where a reader finds it, in both languages. A change in behaviour edits that page, and another page only where what its reader does changes; `GLOSSARY.md` changes only when a term's boundary does.

## Worktrees and local state

- Pipeline worktrees live under `.worktrees/ticket-<n>`, beside the `.worktrees/base-<commit>` a Run makes to run a failing Check again at a branch's merge-base with the base branch and removes once it has run; Run logs under `.ticket-runner/`. Both directories are gitignored and safe to delete when no Run is running: a Ticket's work is on its branch on the remote, pushed after every committing Stage, and a worktree deleted here is made again from it.
- A Ticket's resume state lives on the Target's remote, not in the checkout: `ticket-<n>.json` on the `ticket-runner/state` branch, with a handed-off Ticket's Stage transcripts under `ticket-<n>/` beside it, which the pipeline rewrites as a single snapshot commit and force-pushes with a lease (ADR-0004). A Ticket keeps that file from the claim until its branch carries nothing left to resume — it merges, its issue closes, its branch is in neither its worktree here nor on the remote, or it is handed off at setup over a branch no Stage of the Run worked on — so it is also what a Run killed mid-Ticket, and a Ticket handed to a human, leave behind for the next Run on any Host. Never commit to that branch by hand while a Run is running.
- The Run lock lives on the Target's remote too, as `lock.json` on the `ticket-runner/lock` branch, which always exists once a Run has started: each take and release is a commit on the tip it read, pushed with a lease on that tip, and nothing is ever deleted from it (ADR-0008). A Run takes over a lock only when it names a Run on the same Host whose process has gone. The one commit a human makes there is a `lock.json` reading `{ "held": false }`, to release a lock a Run on another Host left behind, and only when no Run is running.
- Attended work also happens in a worktree when a Run may be active, so the main checkout stays clean for the pipeline to pull.

## Code

- TypeScript, strict, ESM. Tests are vitest files named `*.test.ts` beside the code they test.
- The orchestrator depends on the three ports (`Tracker`, `AgentRunner`, `Workspace`) as interfaces. Adapters are thin: argument building and output parsing.
- Tests reach the orchestrator through in-memory fakes of the ports. The git-backed `Workspace` is tested against a real temporary repository. Tests never spawn `gh` or `claude`.
- Every external effect goes through a port, the pipeline's own state included: the Run lock and a Ticket's state go through `Workspace` like every other external effect (ADR-0004), so the tests that reach them use the in-memory fake rather than a temporary repo root.
- `scripts/` is this repository's own plumbing, what a workflow runs and no install carries. It stays thin: the judgement it needs is a module in `src/`, where the tests are.
- Name things with the glossary where a term fits. A capitalised term is coined, renamed or redefined only in Planning, and a Stage edits `GLOSSARY.md` only where an Acceptance Criterion gives the wording. Which words are terms follows the `domain-modeling` skill, applied strictly: a word that reads right in lowercase is not one.

## Language

Repo documents, issues, commits and code comments are in English so every agent session reads one vocabulary. The Korean README and the wiki's Korean pages are the exception: translations of an English source, kept by the README and Wiki rules above. Conversation with the maintainer is in Korean.

In that Korean text, git's terms are written in English, never transliterated (`merge됩니다`, `commit하지 않습니다`), `worktree`, `checkout` and `remote` among them, and so are the glossary's terms and `pull request`. Each keeps its own case, a glossary term capitalised and any other word lowercase, even where it opens a heading or a table cell. A word the glossary does not list stays in English where English is what people working in the field say, and any other is written in Korean that reads as Korean rather than as a translation. The words the glossary once listed and no longer does are written this way:

| English | Korean text |
|---|---|
| base branch | base branch |
| verify Stage, conflict Stage | verify Stage, conflict Stage |
| Run lock | Run lock |
| Stage mark, session mark | Stage 표시, session 표시 |
| Target readiness | Target 준비 상태 |
| state file, state | state file, state |
| progress comment, progress cell | 진행 상황 코멘트, 진행 상황 칸 |
| subscription, API key (for credential) | 구독, API key |
| fix budget | fix 기회 |
| verdict | 판정 |
| guard | guard |
| candidate | 후보 |
| claim | claim |
| spend | 사용 금액 |
| execution | 실행 |
| version | 버전 |
| release PR (once version PR) | 릴리스 PR |
| release notes (once version notes) | 릴리스 노트 |

The two renamed words, release PR and release notes, are set phrases, and neither is the Release the glossary lists, which is always capitalised.

Commands, program output and the strings it prints, such as labels and progress cells, stay as they are; a comment in a code block is translated, its code is not. The prose of the wiki and the READMEs, in either language, uses no em-dash (—), and an empty cell in a table's body is an en dash (–).

In English and Korean text alike, prose says pull request, never PR; PR stays only where space is tight — a `PR #<n>` reference, a table cell, a label, a name — and in the set phrase release PR.
