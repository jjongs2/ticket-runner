# ticket-runner conventions <!-- ticket-runner:version 0.5.2 -->

What `ticket-runner` requires of this repository, and nothing else. `ticket-runner init` writes this file and rewrites it whenever those requirements change, so an edit made here does not survive the next `init`. Everything the pipeline leaves to this repository — which commit types and scopes it uses, how it reviews, what it tests — belongs in the repository's own contributing guide.

## Commits

- Subject: `<type>(<scope>): <summary> (#<n>)`, where `<n>` is the Ticket number. Every commit carries the number, so no commit has to be traced back to the work it was part of.
- The type and scope vocabulary is this repository's own. The pipeline reads the shape and the number, never the words.
- A commit subject describes its own commit. The whole branch is summarised by the `title` the implement and fix Stages each answer beside their Notes: one line in the same shape without the `(#<n>)`. The latest one becomes the pull request title, and the pull request title becomes the subject of the squash commit that lands.

## Branches

- `agent/<n>-<slug>` belongs to the pipeline. A Run creates one per Ticket, works in a worktree of it, and pushes it after every Stage that commits. The repository deletes it when the pull request merges, a setting `ticket-runner init` switches on. Nothing else branches there.
- `ticket-runner/lock` and `ticket-runner/state` belong to the pipeline too. The first says which Run holds this repository, and the second keeps the State of every Ticket a Run can resume, and the transcripts of a handed-off Ticket's Stages. Nothing else commits to either, except a human, or an Operator a human asked, releasing a lock a vanished Host left behind.
- A Stage commits only to the branch already checked out in the worktree it was started in. It creates no branch and switches to none.

## What a Stage does not do

- A Stage opens no pull request and closes no issue. The pipeline opens the pull request when the Stage finishes, waits for CI, merges it, and lets the merge close the Ticket.

## What a Ticket needs

A Ticket is one issue the pipeline can implement in a single session. It is refused unless it carries all three:

- **Acceptance Criteria** — unticked task list items, a `- [ ]` at the head of a line, in the issue body or in one of its comments. They are the only thing the verify Stage grades, so a promise written as prose is not one.
- **Blockers as native dependencies** — GitHub's own `blocked by` edges, as `gh issue create --blocked-by <n>` records them. A `Blocked by` section in the body is a human-readable copy and nothing the pipeline reads.
- **The `ready-for-agent` label** — how a Run finds the Ticket. A Run labels it `in-progress` for as long as it holds it.

## Checks

- The Checks of different Tickets may run at the same time, each in its own worktree, because a Run has as many Lanes as `lanes` says. A Target whose Checks need a port, a database or anything else they would have to share keeps `lanes` at one, or makes them independent of each other.

## The Operator's skill

- `.claude/skills/ticket-runner/` belongs to the pipeline. It tells an Operator, the Claude session a human opens on this repository from the Claude app, how to start a Run, report on it and stop it. `ticket-runner init` writes it and rewrites it like this file, so an edit made there does not survive the next `init` either.

## Local directories

Both are `ticket-runner`'s own, both are gitignored by `ticket-runner init`, and neither is ever committed.

- `.worktrees/ticket-<n>/` — one git worktree per claimed Ticket, where its Stages run.
- `.ticket-runner/` — the Run's logs and Stage transcripts. The Run lock and the State a Ticket keeps while its branch has work worth resuming are not here but on the Target's remote, so that a Run on any Host sees which Run holds the Target, and carries on from where a killed Run, or a handed-off Ticket relabelled `ready-for-agent`, stopped.
