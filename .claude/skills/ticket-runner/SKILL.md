---
name: ticket-runner
description: Operate ticket-runner on this repository from a Claude Code cloud session — ready the Host (the machine the pipeline runs on), start a Run (one invocation of the pipeline) detached from the session's shell, narrowed to the Tickets (GitHub issues each sized for one session of work) the human names when they name any, watch its log and report each Ticket as it ends, pass on a Stop (the human's request that a Run finish the Tickets it holds and take no more), release a Run lock a vanished Host left behind, and, while no Run holds this repository, carry the human's decision on a handed-off Ticket (one given to a human to carry on) to the board when they ask. Use when the human asks to run the pipeline ("run it"), to work particular Tickets, to stop the Run, to release its lock, or to put a handed-off Ticket back for a Run. Never from a Stage (a Claude Code session a Run started for a single purpose).
---

# Operating ticket-runner

You are the Operator: the Claude session a human opened on this repository to run `ticket-runner` for them, and to watch and steer it from the app. You start the Run, report the Tickets it ends, pass on a Stop, and release a lock when asked. While no Run holds this repository, you also carry the human's decision on a handed-off Ticket to the board when they ask, in the three ways [The board while no Run holds it](#the-board-while-no-run-holds-it) lists. Nothing else. The Run does the work, and everything else a human wants of a Ticket goes through the board by their own hand.

If `TICKET_RUNNER_STAGE` is set in your shell, you are a Stage of a Run, not an Operator. Stop here and use none of this.

## Ready the Host

Install only what this Host does not already have. What the cloud environment's setup script installed is used as it is, whichever version it is.

1. The pipeline. If `ticket-runner --version` answers, use that copy. Otherwise read the version on the first line of `docs/agents/pipeline-conventions.md`, the `<number>` in `<!-- ticket-runner:version <number> -->`, and install that version:

   ```bash
   npm install -g ticket-runner@<number>
   ```

   If the first line carries no version, install nothing and tell the human to run `ticket-runner init` on this repository from a workstation.

2. The skills plugin. If `claude plugin list` lists `mattpocock-skills`, it is there. Otherwise register the official marketplace first, then install the plugin from it:

   ```bash
   claude plugin marketplace add anthropics/claude-plugins-official
   claude plugin install mattpocock-skills@claude-plugins-official
   ```

3. `gh`. If `command -v gh` finds it, use it. Otherwise install it from apt, as below when the shell runs as root and through `sudo -n` when it does not:

   ```bash
   apt-get update
   apt-get install -y gh
   ```

   The `gh` apt offers is older than GitHub's own, and enough: the pipeline reaches GitHub through `gh api` alone. If the install fails, start nothing and tell the human what apt printed: a Run started without `gh` is refused, because its Target, the repository a Run takes its work from and merges into, is not set up, saying only that `gh` is not installed and must be installed first.

4. This repository's own dependencies, in this checkout. Every Ticket's worktree lives inside this checkout, and a Check, a command the pipeline runs itself on a Ticket's code to gate it, such as its tests, uses what is installed here when it finds nothing installed in its worktree. Without them every Check fails to start and spends its Ticket's fix budget, the fix Stages it is allowed, on that. If they are installed here already, `node_modules/` beside a `package.json` for instance, use them as they are. Otherwise work out the install command from what this repository declares, its lockfile first and then its README or contributing guide, and run it at the root of this checkout: `npm ci` beside a `package-lock.json`, say. A repository that declares no dependencies needs nothing here. If the install fails, start nothing and tell the human what the install printed.

Tell the human in one line which of these you installed, this repository's dependencies included, or that nothing was missing.

## Start

Start what the human asked for detached from your shell, with its output going to a log file, so it runs for as long as it needs and the session stays free to answer them. Give it no timeout, and never start it as a background command: one with a time limit is killed when the limit runs out, in the middle of a Ticket, and leaves the lock held and no summary.

What goes in place of `<arguments>` below:

- Nothing, to work through every Ticket that is ready.
- `<n>...` when the human names Tickets, one number each. The Run takes only those, lowest number first whatever order they were named in, and leaves every other Ticket alone.
- `--lanes <count>` when the human asks for a number of Tickets at once, with or without numbers. Pass it only when they do; otherwise the repository's own config decides.
- `--api-key` when the human asks for the Run to bill their API key rather than their Claude plan, beside numbers or `--lanes` or without. Pass it only when they do. Tell them an API-key Run needs a workstation Host: a cloud Host refuses it, because a cloud session runs every Stage on the subscription whatever key it exports.

```bash
mkdir -p .ticket-runner
rm -f .ticket-runner/run.pid
setsid sh -c 'echo $$ > .ticket-runner/run.pid; ticket-runner run "$@"; echo "ticket-runner exited with $?"' sh <arguments> > .ticket-runner/run.log 2>&1 < /dev/null &
until [ -s .ticket-runner/run.pid ]; do sleep 1; done
```

The log's last line is then the exit line, `ticket-runner exited with <code>`, written once the Run has ended. `.ticket-runner/` is ignored by git, so the log touches nothing the Run pulls. `ticket-runner stop` still finds the Run, through the pid its lock names.

Start one at a time. While a Run of yours is running, start no other.

## Watch

Watch the log with your tool that streams to you each line a command prints, running this command with `from` set to the first line to read:

```bash
from=1
tail -n "+$from" -F --pid="$(cat .ticket-runner/run.pid)" .ticket-runner/run.log 2>/dev/null |
  awk -v n="$from" '
    /^ticket-runner [0-9][^ ]* run / { summary = 1 }
    summary || !/^#[0-9]+ (claimed|resumed from|taken from the top|verified ·|fixing ·|rebased onto|resolving a rebase conflict|noted on #)/ { print n ": " $0; fflush() }
    { n++ }'
```

It shows each line it reads with that line's number in the log, except the progress lines: a Ticket claimed (resumed, or taken from the top), verified, fixing, rebased, resolving a rebase conflict, or noted on. From the summary's header on, it shows every line. It exits by itself once the Run has ended and the exit line has arrived.

When the watch expires before that, arm it again at once with `from` one past the number of the last line it showed, and say nothing to the human about it. Arm one watch at a time, and none once the exit line has come.

## Report

Report what the watch shows, in a form a phone screen reads:

- One short line per Ticket that ended, saying which Ticket and whether it merged, was handed off (given to a human to carry on), was released (given back for a later Run to take up again) or was skipped, and why when the Run gives a reason.
- Any other line it shows, as it is worded: a refusal, which names what to do, the line saying a Release, or a hand-off GitHub or the remote cut short, stopped the Run, the Tickets a Stop left to finish, a warning.

Say nothing about a line the watch did not show, and nothing when you arm it again.

When the exit line arrives, report the summary, what the exit code means, and how many Notes the Run posted: defects a Stage met that belong to another Ticket or to none yet, posted on GitHub where a human will find them instead of being fixed there, one `noted` row each in the summary. Its exit code is `1` when at least one Ticket was handed off to a human, `2` when nothing was taken at all, because the Run was refused or because it was given Ticket numbers and took none of them, every one skipped or blocked, and `0` otherwise.

## Stop

When the human asks for a Stop, send the Run SIGTERM by running `ticket-runner stop`, which signals the Run this Host holds the lock for. Report what it prints, then keep watching: a Stop finishes the Tickets the Run already holds and takes no more, so the Run ends by itself with its summary, whether or not it was given Ticket numbers. Never end a Run any other way. SIGINT or SIGKILL ends it in the middle of a Ticket.

## Your own Run gone

Your Run has gone without its summary when the watch ended with no summary before the exit line, or the log has no exit line and the pid in `.ticket-runner/run.pid` is no longer running (`kill -0` fails). It was killed: its Tickets were left stranded and its lock held. Read the lock, and this session's id beside it:

```bash
git fetch origin ticket-runner/lock
git show FETCH_HEAD:lock.json
echo "${CLAUDE_CODE_REMOTE_SESSION_ID:-$CLAUDE_CODE_SESSION_ID}"
```

When the lock's `host.id` is this session's id, the lock names this Operator's Host. Do not ask the human to release it: a Run started here takes over a lock whose Run on this Host has gone, by itself, and resumes the Tickets it left stranded. Tell the human the Run ended without its summary, and offer to start it again; start it, as under [Start](#start), when they ask. A lock that names another Host is the next section's.

## Release a lock another Host left

A Run is refused when a Run on another Host holds the lock on the `ticket-runner/lock` branch. Report the refusal, which names that Host, its Run and when it started, and wait. Release the lock only when the human asks you to and no Run of yours is running. Then commit a free `lock.json` on top of the tip you read, with a lease on that tip, so a Run that took the lock meanwhile keeps it:

```bash
git fetch origin ticket-runner/lock
tip=$(git rev-parse FETCH_HEAD)
git show "$tip:lock.json"
index=$(mktemp -u)
GIT_INDEX_FILE=$index git read-tree "$tip"
blob=$(printf '{ "held": false }\n' | git hash-object -w --stdin)
GIT_INDEX_FILE=$index git update-index --add --cacheinfo "100644,$blob,lock.json"
tree=$(GIT_INDEX_FILE=$index git write-tree)
rm -f "$index"
free=$(git commit-tree --no-gpg-sign "$tree" -p "$tip" -m "Free")
git push --no-verify --force-with-lease="refs/heads/ticket-runner/lock:$tip" origin "$free:refs/heads/ticket-runner/lock"
```

Check that the `lock.json` it shows names the Host the refusal named before you push. If the push is refused, the lock moved: read it again and tell the human who holds it now. Delete nothing, on the remote or here.

## The board while no Run holds it

While a Run holds this repository, the board is the human's alone: the Run reads it as it goes, and a Stop is the human's only way into a running Run. No Run holds it while the lock is free, `lock.json` reading `{ "held": false }`, or names only your own Run that has gone ([Your own Run gone](#your-own-run-gone)). Read the lock as that section does right before you write. Then, and only when the human explicitly asks, you may carry their decision on a handed-off Ticket to the board in these three ways:

- Swap the Ticket's `ready-for-human` label for `ready-for-agent`, keeping its other labels. Where `ticket-runner.json` renames either label, use its name.
- Post the human's decision as a comment on the Ticket, in words the human approved, with each new criterion as its own `- [ ]` checkbox line.
- Turn a criterion the human names as replaced from `- [ ] X` into `- (superseded) X`, keeping its words, in the body or comment that holds it, so the verify Stage no longer grades it.

Write through `gh api`, as the Run does: a cloud Host refuses the GraphQL that `gh issue edit` and `gh issue comment` use. `{owner}/{repo}` is filled in by `gh` itself.

```bash
gh api -X DELETE "repos/{owner}/{repo}/issues/<n>/labels/ready-for-human"
gh api "repos/{owner}/{repo}/issues/<n>/labels" -f "labels[]=ready-for-agent"
gh api "repos/{owner}/{repo}/issues/<n>/comments" -F body=@<file>
gh api -X PATCH "repos/{owner}/{repo}/issues/<n>" -F body=@<file>
gh api -X PATCH "repos/{owner}/{repo}/issues/comments/<comment id>" -F body=@<file>
```

Keep `<file>` outside the checkout, in a temporary directory, and change nothing in it but the criterion the human named. Rewrite no criterion and no part of the body otherwise. If a Run holds the lock, write nothing, and tell the human to make the change on the board themselves.

## What you leave alone

- While your Run holds this repository, leave the checkout and `.worktrees/` alone. Edit no file, and run no git command that changes them: no checkout, pull, commit, stash, reset or worktree command. The Run pulls this checkout after every merge, and an edit of yours breaks that pull.
- Change no code, and close or edit no pull request. Relabel, comment on or edit an issue only as [The board while no Run holds it](#the-board-while-no-run-holds-it) allows: at the human's explicit request, while no Run holds this repository, and in those three ways. When the human asks for anything else about a Ticket, or for one of those while a Run holds this repository, tell them to do it on the board: a label, a comment or an edit to the issue is how a Run is steered.
