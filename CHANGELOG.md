# Changelog

One section per Version, newest first, written in the Version PR that cut it and
published as the body of that Version's GitHub Release (ADR-0007). The shape is
`docs/templates/version-notes.md`.

## 0.5.1 (2026-09-25)

### Fixes

- A Ticket branches from, and rebases onto, the remote's Base branch, not the checkout's ([#177])

### After upgrading

- Run `agent-pipeline init` again in every Target, so a cloud Host installs this Version rather than the one stamped before.

[#177]: https://github.com/jjongs2/agent-pipeline/pull/177

## 0.5.0 (2026-09-25)

### Cloud Host

- ADR-0008 records the cloud Host as a Claude Code cloud session; CONTEXT.md defines Host and Operator ([#145])
- The Tracker reads and writes issues, pull requests and the default branch over REST ([#158], [#159], [#170])
- The Operator's skill starts a Run or a Ticket in the background and installs `gh` when missing ([#166], [#172])

### Run lock and resume state

- The Run lock and a Ticket's resume state move to GitHub, behind a new Workspace port ([#160], [#164], [#162])
- A Ticket's branch pushes after every committing Stage and resumes from the remote, transcripts included ([#161], [#163])

### After upgrading

- Run `agent-pipeline init` again in every Target; readiness now refuses one missing branch deletion, a Version stamp, or the Operator's skill.

[#145]: https://github.com/jjongs2/agent-pipeline/pull/145
[#158]: https://github.com/jjongs2/agent-pipeline/pull/158
[#159]: https://github.com/jjongs2/agent-pipeline/pull/159
[#160]: https://github.com/jjongs2/agent-pipeline/pull/160
[#161]: https://github.com/jjongs2/agent-pipeline/pull/161
[#162]: https://github.com/jjongs2/agent-pipeline/pull/162
[#163]: https://github.com/jjongs2/agent-pipeline/pull/163
[#164]: https://github.com/jjongs2/agent-pipeline/pull/164
[#166]: https://github.com/jjongs2/agent-pipeline/pull/166
[#170]: https://github.com/jjongs2/agent-pipeline/pull/170
[#172]: https://github.com/jjongs2/agent-pipeline/pull/172

## 0.4.5 (2026-09-23)

### Fixes

- The Checks now catch uncommitted work left in the worktree and spend the fix budget on it ([#143])
- The implement Stage's review now lands before it answers, and a later answer keeps every earlier Note ([#141])

### After upgrading

- nothing

[#141]: https://github.com/jjongs2/agent-pipeline/pull/141
[#143]: https://github.com/jjongs2/agent-pipeline/pull/143

## 0.4.4 (2026-09-23)

### Stages

- A Stage runs `claude-opus-5-5` by default, and a Target can set its effort ([#136])

### Hand-off

- A handed-off Ticket resumes from where it stopped, not from the start ([#135])
- The conventions document now says a handed-off Ticket keeps its State file too ([#138])

### After upgrading

- Run `agent-pipeline init` again in every Target; the conventions document's State file line now covers a handed-off Ticket too.

[#135]: https://github.com/jjongs2/agent-pipeline/pull/135
[#136]: https://github.com/jjongs2/agent-pipeline/pull/136
[#138]: https://github.com/jjongs2/agent-pipeline/pull/138

## 0.4.3 (2026-09-22)

### Notes

- A Stage is told the bar a Note must clear before writing one, and the verify Stage holds itself to the same evidence standard ([#129])

### After upgrading

- nothing

[#129]: https://github.com/jjongs2/agent-pipeline/pull/129

## 0.4.2 (2026-09-22)

### Notes

- A Note that reaches triage becomes a comment on one standing issue instead of opening a new one ([#124])
- The verify Stage can put what it finds outside the Acceptance Criteria in a Note ([#125])

### Fixes

- The Run lock checks a recycled pid against the holder's recorded start time ([#126])

### After upgrading

- nothing

[#124]: https://github.com/jjongs2/agent-pipeline/pull/124
[#125]: https://github.com/jjongs2/agent-pipeline/pull/125
[#126]: https://github.com/jjongs2/agent-pipeline/pull/126

## 0.4.1 (2026-09-21)

### Fixes

- A pull request whose checks GitHub registers late waits out a grace instead of a hand-off ([#120])
- A hand-off comment left by an earlier Run is marked history when the Ticket is claimed again ([#118])
- An unknown option answers with the usage, not a stack trace ([#115])
- The usage explains the pipeline in plain words, and `-v` says the Version ([#117])

### Repository

- A `node_modules` symlink is ignored like the directory, and the broken one on `main` is gone ([#112])
- Version notes carry a link definition for every pull request they name ([#110])

### After upgrading

- Nothing is required; a Target whose Actions queue registers checks slowly can raise `ciGraceMinutes`, which defaults to 5.

[#110]: https://github.com/jjongs2/agent-pipeline/pull/110
[#112]: https://github.com/jjongs2/agent-pipeline/pull/112
[#115]: https://github.com/jjongs2/agent-pipeline/pull/115
[#117]: https://github.com/jjongs2/agent-pipeline/pull/117
[#118]: https://github.com/jjongs2/agent-pipeline/pull/118
[#120]: https://github.com/jjongs2/agent-pipeline/pull/120

## 0.4.0 (2026-09-20)

### Versions

- A Version is cut by merging a Version PR; the push to `main` tags it and publishes the Release; ADR-0007 ([#94], [#95], [#102], [#106])
- `agent-pipeline --version` says which Version this is, and the Run summary, Progress comments, `init` report and State files carry it ([#100])
- An install follows the highest tag rather than `main`, so the install line changed ([#102])
- A Run and `init` say when a newer Version is out, or the Target's conventions document is from another one, and refuse nothing over it ([#104])

### Fixes

- A Stage is told a Note's first sentence becomes its issue title ([#107])

### After upgrading

- Reinstall with the new line, which follows tags: `npm install -g "github:jjongs2/agent-pipeline#semver:*"`.
- Run `agent-pipeline init` again in every Target; the conventions document now carries the Version that wrote it, and a Run warns until it does.

[#94]: https://github.com/jjongs2/agent-pipeline/pull/94
[#95]: https://github.com/jjongs2/agent-pipeline/pull/95
[#100]: https://github.com/jjongs2/agent-pipeline/pull/100
[#102]: https://github.com/jjongs2/agent-pipeline/pull/102
[#104]: https://github.com/jjongs2/agent-pipeline/pull/104
[#106]: https://github.com/jjongs2/agent-pipeline/pull/106
[#107]: https://github.com/jjongs2/agent-pipeline/pull/107

## 0.3.1 (2026-09-20)

### Stop

- `agent-pipeline stop` finishes the Lanes' Tickets and takes no more; Ctrl+C stays a kill; ADR-0006 ([#88], [#91], [#93])

### Fixes

- A Note stays off a claimed, closed or Spec issue ([#85])
- A rate limit is read off the 429, not the wording ([#87])

### After upgrading

- nothing

[#85]: https://github.com/jjongs2/agent-pipeline/pull/85
[#87]: https://github.com/jjongs2/agent-pipeline/pull/87
[#88]: https://github.com/jjongs2/agent-pipeline/pull/88
[#91]: https://github.com/jjongs2/agent-pipeline/pull/91
[#93]: https://github.com/jjongs2/agent-pipeline/pull/93

## 0.3.0 (2026-09-19)

### Lanes

- A Run takes `lanes` Tickets at once, default one ([#82], [#83])
- One Lane at a time is in the Landing, rebase to post-merge pull; ADR-0005 ([#77], [#81])
- A Release stops the Run filling Lanes; busy Lanes finish ([#83])
- Ticket log lines start with `#<n>` ([#82])

### After upgrading

- Run `agent-pipeline init` again in every Target; the conventions document gained the Checks-in-parallel line. Keep `lanes` at one where Checks share a port or database.

[#77]: https://github.com/jjongs2/agent-pipeline/pull/77
[#81]: https://github.com/jjongs2/agent-pipeline/pull/81
[#82]: https://github.com/jjongs2/agent-pipeline/pull/82
[#83]: https://github.com/jjongs2/agent-pipeline/pull/83

## 0.2.0 (2026-09-18)

### Any Target

- `init` sets a Target up and reports what only a human can ([#71])
- A Run refuses a Target `init` has not set up ([#72])
- A Run works against the Target's Base branch; `baseBranch` overrides ([#70])

### After upgrading

- Run `agent-pipeline init` once in every Target; a Run now refuses one without it.

[#70]: https://github.com/jjongs2/agent-pipeline/pull/70
[#71]: https://github.com/jjongs2/agent-pipeline/pull/71
[#72]: https://github.com/jjongs2/agent-pipeline/pull/72

## 0.1.1 (2026-09-18)

### Resuming

- A killed Run leaves Stranded Tickets; the next Run sweeps and resumes them ([#42])
- A branch that outlived its worktree is handed off, not reused ([#45])
- A setup hand-off names no missing worktree and pushes no branch ([#56], [#64])

### Fixes

- A killed Stage settles without waiting on descendants' pipes ([#41], [#54])
- A Check past `checkTimeoutMinutes` is killed and fails ([#58])
- A timed-out Stage is read from the kill, not exit code 124 ([#67])
- A Stage is read from every result event ([#51])
- A fix Stage that commits nothing ends the Ticket ([#48])
- CI evidence carries the failing job's log excerpt ([#46])
- Numbers are read only from issue or PR URLs ([#43])
- A Run ends at its first Release ([#49])

### After upgrading

- nothing

[#41]: https://github.com/jjongs2/agent-pipeline/pull/41
[#42]: https://github.com/jjongs2/agent-pipeline/pull/42
[#43]: https://github.com/jjongs2/agent-pipeline/pull/43
[#45]: https://github.com/jjongs2/agent-pipeline/pull/45
[#46]: https://github.com/jjongs2/agent-pipeline/pull/46
[#48]: https://github.com/jjongs2/agent-pipeline/pull/48
[#49]: https://github.com/jjongs2/agent-pipeline/pull/49
[#51]: https://github.com/jjongs2/agent-pipeline/pull/51
[#54]: https://github.com/jjongs2/agent-pipeline/pull/54
[#56]: https://github.com/jjongs2/agent-pipeline/pull/56
[#58]: https://github.com/jjongs2/agent-pipeline/pull/58
[#64]: https://github.com/jjongs2/agent-pipeline/pull/64
[#67]: https://github.com/jjongs2/agent-pipeline/pull/67

## 0.1.0 (2026-09-17)

### Tickets

- `ticket <n>` takes a Ticket from Claim to squash merge: worktree, implement, Checks, Verify, rebase, PR, CI ([#9])
- One fix Stage per Ticket; a second failure hands off with a draft PR ([#27])
- A rebase conflict goes to a Conflict Stage ([#28])
- Squash commits keep the PR number, `Closes`, the Verdict and co-authors ([#20], [#24])

### Runs

- `run` drains the Frontier, lowest number first ([#14])
- Guards reject a Spec, missing Acceptance Criteria or body-only blockers, and warn once ([#25])
- A rate-limited Ticket is released, not handed off, and resumes from a State file ([#34], [#36])
- A Stage's Note goes to the Ticket it belongs to, or opens a `needs-triage` issue ([#39])
- One Progress comment per Ticket, edited in place ([#30])

### Fixes

- A Stage cannot start a nested Run ([#16])
- Stage logs are written while the Stage runs ([#22])
- The CI wait no longer gives up before checks register ([#18])

### After upgrading

- First Version. A Target needs the triage labels, `.worktrees/` and `.agent-pipeline/` gitignored, and Tickets with `- [ ]` criteria, native `blocked by` edges and `ready-for-agent`.

[#9]: https://github.com/jjongs2/agent-pipeline/pull/9
[#14]: https://github.com/jjongs2/agent-pipeline/pull/14
[#16]: https://github.com/jjongs2/agent-pipeline/pull/16
[#18]: https://github.com/jjongs2/agent-pipeline/pull/18
[#20]: https://github.com/jjongs2/agent-pipeline/pull/20
[#22]: https://github.com/jjongs2/agent-pipeline/pull/22
[#24]: https://github.com/jjongs2/agent-pipeline/pull/24
[#25]: https://github.com/jjongs2/agent-pipeline/pull/25
[#27]: https://github.com/jjongs2/agent-pipeline/pull/27
[#28]: https://github.com/jjongs2/agent-pipeline/pull/28
[#30]: https://github.com/jjongs2/agent-pipeline/pull/30
[#34]: https://github.com/jjongs2/agent-pipeline/pull/34
[#36]: https://github.com/jjongs2/agent-pipeline/pull/36
[#39]: https://github.com/jjongs2/agent-pipeline/pull/39
