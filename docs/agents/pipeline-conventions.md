# ticket-runner conventions <!-- ticket-runner:version 0.6.4 -->

What `ticket-runner` requires of this repository, and nothing else. `ticket-runner init` writes this file and rewrites it whenever those requirements change, so an edit made here does not survive the next `init`. Everything the pipeline leaves to this repository — which commit types and scopes it uses, how it reviews, what it tests — belongs in the repository's own contributing guide.

A capitalised word below is one of the pipeline's own terms, said in a few words where it first appears; every other word means what it ordinarily does. To the pipeline this repository is a Target, the repository a Run takes its work from and merges into. A Run is one invocation of the pipeline on a Host, the machine it executes on, and works through Tickets, GitHub issues each sized for one session of work, until it has none left to take or is told to take no more. Each Ticket is worked by Stages, each one Claude Code session with a single purpose: implement, verify, fix, or resolve a rebase conflict. A Stage may answer Notes beside its work: defects it met that belong to another Ticket or to none yet, recorded where a human will find them instead of being fixed there.

## Commits

- Subject: `<type>(<scope>): <summary>`.
- The type and scope vocabulary is this repository's own. The pipeline reads the shape, never the words.
- A commit subject describes its own commit. The whole branch is summarised by the `title` the implement and fix Stages each answer beside their Notes: one line in the same shape. The latest one becomes the pull request title, and the pull request title becomes the subject of the squash commit that lands.

## Branches

- `agent/<n>-<slug>` belongs to the pipeline. A Run creates one per Ticket, works in a worktree of it, and pushes it after every Stage that commits. The repository deletes it when the pull request merges, a setting `ticket-runner init` switches on. Nothing else branches there.
- `ticket-runner/lock` and `ticket-runner/state` belong to the pipeline too. The first says which Run holds this repository, and the second keeps the state file of every Ticket a Run can resume, and the transcripts of the Stages of a Ticket handed off, given to a human in a Hand-off rather than merged. Nothing else commits to either, except a human, or an Operator a human asked, releasing a lock a vanished Host left behind. An Operator is the Claude session a human opens on a cloud Host from the Claude app to start a Run, watch it and stop it.
- A Stage commits only to the branch already checked out in the worktree it was started in. It creates no branch and switches to none.

## What a Stage does not do

- A Stage opens no pull request and closes no issue. The pipeline opens the pull request when the Stage finishes, waits for CI, merges it, and lets the merge close the Ticket.

## What a Ticket needs

A Ticket is one issue the pipeline can implement in a single session. It is refused unless it carries all three:

- **Acceptance Criteria** — unticked task list items, a `- [ ]` at the head of a line, in the issue body or in one of its comments. They are the only thing the verify Stage grades, so a promise written as prose is not one.
- **Blockers as native dependencies** — GitHub's own `blocked by` edges, as `gh issue create --blocked-by <n>` records them. A `Blocked by` section in the body is a human-readable copy and nothing the pipeline reads.
- **The `ready-for-agent` label** — how a Run finds the Ticket. A Run labels it `in-progress` for as long as it holds it.

## Checks

- A Check is a command the pipeline runs itself on a Ticket's code to gate it, such as its tests or its typecheck, and never the CI on a pull request, which the pipeline only waits for. The Checks of different Tickets may run at the same time, each in its own worktree, because a Run has as many Lanes, the places it holds a Ticket in progress, one Ticket each, as `lanes` says. A Target whose Checks need a port, a database or anything else they would have to share keeps `lanes` at one, or makes them independent of each other.
- A Check that fails on a Ticket's branch, or CI that fails on its pull request, is graded again at what the branch inherited: the pipeline runs the Check commands in a clean worktree at the branch's merge-base with the base branch. One that fails there too is the base branch's, not the Ticket's, so the Ticket is released without spending its fix budget, the fix Stages it is allowed, the Run claims no more Tickets, and the pipeline posts a Note on the standing Notes issue naming the Check. A Release gives a Ticket back to the pipeline because something outside the Ticket stopped its work, and a later Run takes it up again. The next Run rebases the Ticket onto the base branch before its Checks, so mending the base branch is what frees it. Nothing is installed in the worktree at the merge-base: its Checks find their dependencies in the main checkout, as a Ticket's worktree does, so Checks that need an install or a build step of their own fail there and release the Ticket, and the Note's output shows it.

## The Operator's skill

- `.claude/skills/ticket-runner/` belongs to the pipeline. It tells an Operator how to start a Run, report on it and pass on a Stop, a human's request that the Run finish the Tickets its Lanes hold and take no more. `ticket-runner init` writes it and rewrites it like this file, so an edit made there does not survive the next `init` either.

## Local directories

Both are `ticket-runner`'s own, both are gitignored by `ticket-runner init`, and neither is ever committed.

- `.worktrees/ticket-<n>/` — one git worktree per claimed Ticket, where its Stages run. Beside them, `.worktrees/base-<commit>/` is a clean worktree at a merge-base with the base branch, made to run a failing Check there once and removed when it has run.
- `.ticket-runner/` — the Run's logs and Stage transcripts. The Run lock and the state file a Ticket keeps while its branch has work worth resuming are not here but on the Target's remote, so that a Run on any Host sees which Run holds the Target, and carries on from where a killed Run, or a handed-off Ticket relabelled `ready-for-agent`, stopped.
