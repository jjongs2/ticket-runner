# Changelog

One section per Version, newest first, written in the Version PR that cut it and
published as the body of that Version's GitHub Release (ADR-0007). The shape is
`docs/templates/version-notes.md`.

## 0.3.1 (2026-09-20)

### Stop

- `agent-pipeline stop` finishes the Lanes' Tickets and takes no more; Ctrl+C stays a kill; ADR-0006 (#88, #91, #93)

### Fixes

- A Note stays off a claimed, closed or Spec issue (#85)
- A rate limit is read off the 429, not the wording (#87)

### After upgrading

- nothing

## 0.3.0 (2026-09-19)

### Lanes

- A Run takes `lanes` Tickets at once, default one (#82, #83)
- One Lane at a time is in the Landing, rebase to post-merge pull; ADR-0005 (#77, #81)
- A Release stops the Run filling Lanes; busy Lanes finish (#83)
- Ticket log lines start with `#<n>` (#82)

### After upgrading

- Run `agent-pipeline init` again in every Target; the conventions document gained the Checks-in-parallel line. Keep `lanes` at one where Checks share a port or database.

## 0.2.0 (2026-09-18)

### Any Target

- `init` sets a Target up and reports what only a human can (#71)
- A Run refuses a Target `init` has not set up (#72)
- A Run works against the Target's Base branch; `baseBranch` overrides (#70)

### After upgrading

- Run `agent-pipeline init` once in every Target; a Run now refuses one without it.

## 0.1.1 (2026-09-18)

### Resuming

- A killed Run leaves Stranded Tickets; the next Run sweeps and resumes them (#42)
- A branch that outlived its worktree is handed off, not reused (#45)
- A setup hand-off names no missing worktree and pushes no branch (#56, #64)

### Fixes

- A killed Stage settles without waiting on descendants' pipes (#41, #54)
- A Check past `checkTimeoutMinutes` is killed and fails (#58)
- A timed-out Stage is read from the kill, not exit code 124 (#67)
- A Stage is read from every result event (#51)
- A fix Stage that commits nothing ends the Ticket (#48)
- CI evidence carries the failing job's log excerpt (#46)
- Numbers are read only from issue or PR URLs (#43)
- A Run ends at its first Release (#49)

### After upgrading

- nothing

## 0.1.0 (2026-09-17)

### Tickets

- `ticket <n>` takes a Ticket from Claim to squash merge: worktree, implement, Checks, Verify, rebase, PR, CI (#9)
- One fix Stage per Ticket; a second failure hands off with a draft PR (#27)
- A rebase conflict goes to a Conflict Stage (#28)
- Squash commits keep the PR number, `Closes`, the Verdict and co-authors (#20, #24)

### Runs

- `run` drains the Frontier, lowest number first (#14)
- Guards reject a Spec, missing Acceptance Criteria or body-only blockers, and warn once (#25)
- A rate-limited Ticket is released, not handed off, and resumes from a State file (#34, #36)
- A Stage's Note goes to the Ticket it belongs to, or opens a `needs-triage` issue (#39)
- One Progress comment per Ticket, edited in place (#30)

### Fixes

- A Stage cannot start a nested Run (#16)
- Stage logs are written while the Stage runs (#22)
- The CI wait no longer gives up before checks register (#18)

### After upgrading

- First Version. A Target needs the triage labels, `.worktrees/` and `.agent-pipeline/` gitignored, and Tickets with `- [ ]` criteria, native `blocked by` edges and `ready-for-agent`.
