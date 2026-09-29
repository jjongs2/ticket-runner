# ticket-runner

[한국어](https://github.com/jjongs2/ticket-runner/blob/main/README.ko.md)

Humans plan on GitHub; `ticket-runner` carries each ready issue to a merged pull request while
nobody watches.

## What it does

The work is split in two. **Planning** is yours: you shape a feature into small GitHub issues,
each with a checklist of Acceptance Criteria. You can write them by hand, or with the plugin's
`/grilling`, `/to-spec`, `/to-tickets` and `/triage`. **Execution** is the pipeline's. For every issue labelled
`ready-for-agent` whose blockers have closed, it:

1. claims the issue and creates a branch and a git worktree for it
2. runs a headless `claude -p` session that implements it
3. runs your tests and typecheck itself
4. runs a second, fresh session that tries to prove the Acceptance Criteria are *not* met
5. rebases, opens a pull request, waits for CI and squash-merges

One failure buys one fix session and a second pass. Anything it still cannot finish goes back
to you, labelled `ready-for-human`, with a draft pull request and a comment saying what failed.
A session stopped by your subscription's rate limit costs nothing: the issue goes back on the
board, and the next Run carries on from where it stopped.

## Is it for you?

It fits a repository where:

- issues live on GitHub, and you are willing to write each one small enough for one session,
  with `- [ ]` Acceptance Criteria and blockers as GitHub's native `blocked by` links
- a CI workflow runs on pull requests, and there is a test or typecheck command the pipeline can
  run itself
- the machine running it has Node 22 or newer, `git`, an authenticated
  [`gh`](https://cli.github.com/), and `claude` with the
  [`mattpocock-skills`](https://github.com/mattpocock/skills) plugin, version 1.2.3

It merges to your base branch without asking. It is for repositories where that is what you want.

## Try it

In the repository you want it to work in (the **Target**):

```bash
npx ticket-runner init   # set the Target up and report what is still missing
npx ticket-runner run    # work through every ready issue
```

`init` writes a few files for you to review and commit: `.gitignore` lines, a conventions
document, a section in `CLAUDE.md` and a Claude skill. It also creates the triage labels and
turns on squash merging and branch deletion on merge. It commits nothing.

To keep it, install it globally:

```bash
npm install -g ticket-runner
```

| Command | What it does |
|---|---|
| `ticket-runner init` | Set this repository up, and report what only you can put right |
| `ticket-runner run` | Work through every ready issue, one at a time |
| `ticket-runner run 12 14` | The same, taking only #12 and #14 |
| `ticket-runner run --lanes 2` | Two issues at once |
| `ticket-runner stop` | Ask the Run in progress to finish what it holds and take no more |
| `ticket-runner remove` | Take the pipeline out of this repository |
| `ticket-runner -v` | Print the Version |

A Run can also be started from the Claude app, in a Claude Code cloud session on the Target:
say "run it".

## Take it out again

```bash
ticket-runner remove           # in the Target: what init wrote and what Runs left behind
npm uninstall -g ticket-runner # the global install
```

`remove` asks first (`--yes` skips the question), commits nothing, and reports what it left
alone on purpose, such as open pull requests and the issues it commented on. `npx` leaves nothing
behind but its cache.

## Learn more

The [project wiki](https://jjongs2.github.io/ticket-runner/) explains the pipeline in depth:

- [Install and remove](https://jjongs2.github.io/ticket-runner/guide/installation)
- [Planning the work](https://jjongs2.github.io/ticket-runner/guide/planning)
- [Running](https://jjongs2.github.io/ticket-runner/guide/running)
- [Configuration](https://jjongs2.github.io/ticket-runner/guide/configuration)
- [From Ticket to merge](https://jjongs2.github.io/ticket-runner/guide/ticket-to-merge)
- [Stopping and resuming](https://jjongs2.github.io/ticket-runner/guide/stopping-and-resuming)
- [Internals](https://jjongs2.github.io/ticket-runner/guide/internals)

The vocabulary is defined in [`CONTEXT.md`](https://github.com/jjongs2/ticket-runner/blob/main/CONTEXT.md), the decisions in
[`docs/adr/`](https://github.com/jjongs2/ticket-runner/tree/main/docs/adr), and the conventions for working on the pipeline itself in
[`CONTRIBUTING.md`](https://github.com/jjongs2/ticket-runner/blob/main/CONTRIBUTING.md).
