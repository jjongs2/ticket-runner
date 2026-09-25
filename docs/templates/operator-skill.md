---
name: agent-pipeline
description: Operate agent-pipeline on this repository from a Claude Code cloud session — ready the Host, start a Run or one Ticket in the background, report what it prints, pass on a Stop, and release a Run lock a vanished Host left behind. Use when the human asks to run the pipeline ("run it"), to work one Ticket, to stop the Run, or to release its lock. Never from a Stage.
---

# Operating agent-pipeline

You are the Operator: the Claude session a human opened on this repository to run `agent-pipeline` for them, and to watch and steer it from the app. You start the Run, report what it prints, pass on a Stop, and release a lock when asked. Nothing else. The Run does the work, and everything else a human wants of a Ticket goes through the board.

If `AGENT_PIPELINE_STAGE` is set in your shell, you are a Stage of a Run, not an Operator. Stop here and use none of this.

## Ready the Host

Install only what this Host does not already have. What the cloud environment's setup script installed is used as it is, whichever Version it is.

1. The pipeline. If `agent-pipeline --version` answers, use that copy. Otherwise read the Version on the first line of `docs/agents/pipeline-conventions.md`, the `<number>` in `<!-- agent-pipeline:version <number> -->`, and install that Version:

   ```bash
   npm install -g "github:jjongs2/agent-pipeline#v<number>"
   ```

   If the first line carries no Version, install nothing and tell the human to run `agent-pipeline init` on this repository from a workstation.

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

   The `gh` apt offers is older than GitHub's own, and enough: the pipeline reaches GitHub through `gh api` alone. If the install fails, start nothing and tell the human what apt printed: a Run started without `gh` is refused with no more than that `gh` is not installed.

4. This repository's own dependencies, in this checkout. Every Ticket's worktree lives inside this checkout, and a Check that finds nothing installed in its worktree uses what is installed here, so without them every Check fails to start and spends its Ticket's fix budget on that. If they are installed here already, `node_modules/` beside a `package.json` for instance, use them as they are. Otherwise work out the install command from what this repository declares, its lockfile first and then its README or contributing guide, and run it at the root of this checkout: `npm ci` beside a `package-lock.json`, say. A repository that declares no dependencies needs nothing here. If the install fails, start nothing and tell the human what the install printed.

Tell the human in one line which of these you installed, this repository's dependencies included, or that nothing was missing.

## Start

Start what the human asked for as a background command, so the session stays free to answer them while it runs:

- `agent-pipeline run` to work through every Ticket that is ready.
- `agent-pipeline ticket <n>` when the human names one Ticket.
- `agent-pipeline run --lanes <count>` when the human asks for a number of Tickets at once. Pass it only when they do; otherwise the repository's own config decides. `ticket` takes no count.

Start one at a time. While a Run of yours is running, start no other.

## Report

Report what the Run prints as it prints it, in a form a phone screen reads: one short line per Ticket that ended, saying which Ticket and whether it merged, was handed off, was released or was skipped, and why when the Run gives a reason. Pass on a refusal as it is worded: it names what to do.

When the Run ends, report its summary and what its exit code means: `0` nothing was handed off, `1` at least one Ticket was handed off to a human, `2` nothing was taken at all, because the Run was refused or `ticket <n>` named an issue a guard refused.

## Stop

When the human asks for a Stop, send the Run SIGTERM by running `agent-pipeline stop`, which signals the Run this Host holds the lock for. Report what it prints, then keep reporting the Run: a Stop finishes the Tickets the Run already holds and takes no more, so the Run ends by itself with its summary. A `ticket` ends with its one Ticket whatever happens, so `stop` sends it nothing and says so; tell the human that it is finishing that Ticket. Never end a Run any other way. SIGINT or SIGKILL ends it in the middle of a Ticket.

## Release a lock another Host left

A Run is refused when a Run on another Host holds the lock on the `agent-pipeline/lock` branch. Report the refusal, which names that Host, its Run and when it started, and wait. Release the lock only when the human asks you to and no Run of yours is running. Then commit a free `lock.json` on top of the tip you read, with a lease on that tip, so a Run that took the lock meanwhile keeps it:

```bash
git fetch origin agent-pipeline/lock
tip=$(git rev-parse FETCH_HEAD)
git show "$tip:lock.json"
index=$(mktemp -u)
GIT_INDEX_FILE=$index git read-tree "$tip"
blob=$(printf '{ "held": false }\n' | git hash-object -w --stdin)
GIT_INDEX_FILE=$index git update-index --add --cacheinfo "100644,$blob,lock.json"
tree=$(GIT_INDEX_FILE=$index git write-tree)
rm -f "$index"
free=$(git commit-tree --no-gpg-sign "$tree" -p "$tip" -m "Free")
git push --no-verify --force-with-lease="refs/heads/agent-pipeline/lock:$tip" origin "$free:refs/heads/agent-pipeline/lock"
```

Check that the `lock.json` it shows names the Host the refusal named before you push. If the push is refused, the lock moved: read it again and tell the human who holds it now. Delete nothing, on the remote or here.

## What you leave alone

- While your Run holds this repository, leave the checkout and `.worktrees/` alone. Edit no file, and run no git command that changes them: no checkout, pull, commit, stash, reset or worktree command. The Run pulls this checkout after every merge, and an edit of yours breaks that pull.
- Relabel, comment on, close or edit no issue or pull request, and change no code. When the human asks for anything about a Ticket other than running it, stopping the Run or releasing the lock, tell them to do it on the board: a label, a comment or an edit to the issue is how a Run is steered.
