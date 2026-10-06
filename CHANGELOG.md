# Changelog

One section per Version, newest first, written in the Version PR that cut it and
published as the body of that Version's GitHub Release (ADR-0007). The shape is
`docs/templates/version-notes.md`.

## 0.6.1 (2026-10-06)

Each Version now reaches npm and installs with `npm install -g ticket-runner`, and the conflict Stage works with `mattpocock-skills` 1.3.1.

### npm

- Each cut Version is published to npm, and the pipeline names `npm install -g ticket-runner` ([#216])
- The package's npm page carries keywords and a homepage ([#219])

### Fixes

- The conflict Stage runs without a skill, so `mattpocock-skills` 1.3.1 no longer breaks it ([#222])

### Docs

- The README shows the npm Version and the licence as badges ([#217])
- The wiki's diagrams read in the light theme ([#218])
- The Running page compares `/implement-spec` with a Run ([#222])
- Version notes open with a summary, and the Install page points upgrades at them ([#220])

### After upgrading

Run `ticket-runner init` in each Target to refresh the Operator's skill, which now installs from npm. The GitHub tag install keeps working.

[#216]: https://github.com/jjongs2/ticket-runner/pull/216
[#217]: https://github.com/jjongs2/ticket-runner/pull/217
[#218]: https://github.com/jjongs2/ticket-runner/pull/218
[#219]: https://github.com/jjongs2/ticket-runner/pull/219
[#220]: https://github.com/jjongs2/ticket-runner/pull/220
[#222]: https://github.com/jjongs2/ticket-runner/pull/222

## 0.6.0 (2026-09-29)

### ticket-runner

- The pipeline is `ticket-runner` in its package, command, branches, files and markers, under MIT ([#202])
- `ticket-runner remove` takes the pipeline out of a Target, refusing while work is in flight ([#204])
- The package leaves out the tests and their fakes ([#214])

### Runs

- `ticket-runner run 12 13` works only the Tickets it names ([#205])
- A Note is posted as a bold summary, then its Evidence, Impact and Next ([#195])

### Fixes

- A pull request takes the title its Stages answer, not its first commit's subject ([#206])
- A Stage is told it runs in the pipeline's checkout only in the pipeline's own repository ([#213])

### Docs

- A wiki at <https://jjongs2.github.io/ticket-runner/>, and a README rewritten for newcomers ([#207])
- ADR-0004, -0006 and -0008 read as decisions in force ([#211])

### After upgrading

Nothing reads the old name, so move each Target by hand, while no Run holds it and no Ticket is `in-progress`:

1. `npm uninstall -g agent-pipeline`, then `npm install -g "github:jjongs2/ticket-runner#semver:*"`
2. Rename `agent-pipeline.json` to `ticket-runner.json`, and `.agent-pipeline/` to `.ticket-runner/` in the directory and its `.gitignore` line
3. Delete `.claude/skills/agent-pipeline/`, and write `ticket-runner` for `agent-pipeline` in the `CLAUDE.md` section that points at the conventions document
4. Copy the State branch, when there is one, then delete both old branches: `git push origin origin/agent-pipeline/state:refs/heads/ticket-runner/state` and `git push origin --delete agent-pipeline/state agent-pipeline/lock`
5. Run `ticket-runner init`

[#195]: https://github.com/jjongs2/ticket-runner/pull/195
[#202]: https://github.com/jjongs2/ticket-runner/pull/202
[#204]: https://github.com/jjongs2/ticket-runner/pull/204
[#205]: https://github.com/jjongs2/ticket-runner/pull/205
[#206]: https://github.com/jjongs2/ticket-runner/pull/206
[#207]: https://github.com/jjongs2/ticket-runner/pull/207
[#211]: https://github.com/jjongs2/ticket-runner/pull/211
[#213]: https://github.com/jjongs2/ticket-runner/pull/213
[#214]: https://github.com/jjongs2/ticket-runner/pull/214

## 0.5.2 (2026-09-25)

### Progress comments

- A Ticket's Progress comment keeps each Run's own section, and drops another Run's footer from an earlier one ([#185], [#192])

### Fixes

- A Host without `gh` installed is told so, instead of being asked to log in ([#190])
- A Stage installs the Target's dependencies and keeps them past its clean-worktree check ([#191])
- A conflicting pull request hands off as a conflict, without waiting out the grace period ([#183])
- `init` counts a label GitHub already has as present, instead of failing ([#182])
- A pull request body names only the transcripts that outlive the Host ([#181])

### Versions

- `/cut-a-version` confirms the number and the notes with the maintainer before opening the Version PR ([#184])
- Attended work too small for a Ticket opens a pull request on `human/<slug>`, without one ([#184])

### After upgrading

- Run `agent-pipeline init` again in every Target: the Operator's skill's `gh` wording and its dependency-install line both changed.

[#181]: https://github.com/jjongs2/ticket-runner/pull/181
[#182]: https://github.com/jjongs2/ticket-runner/pull/182
[#183]: https://github.com/jjongs2/ticket-runner/pull/183
[#184]: https://github.com/jjongs2/ticket-runner/pull/184
[#185]: https://github.com/jjongs2/ticket-runner/pull/185
[#190]: https://github.com/jjongs2/ticket-runner/pull/190
[#191]: https://github.com/jjongs2/ticket-runner/pull/191
[#192]: https://github.com/jjongs2/ticket-runner/pull/192

## 0.5.1 (2026-09-25)

### Fixes

- A Ticket branches from, and rebases onto, the remote's Base branch, not the checkout's ([#177])

### After upgrading

- Run `agent-pipeline init` again in every Target, so a cloud Host installs this Version rather than the one stamped before.

[#177]: https://github.com/jjongs2/ticket-runner/pull/177

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

[#145]: https://github.com/jjongs2/ticket-runner/pull/145
[#158]: https://github.com/jjongs2/ticket-runner/pull/158
[#159]: https://github.com/jjongs2/ticket-runner/pull/159
[#160]: https://github.com/jjongs2/ticket-runner/pull/160
[#161]: https://github.com/jjongs2/ticket-runner/pull/161
[#162]: https://github.com/jjongs2/ticket-runner/pull/162
[#163]: https://github.com/jjongs2/ticket-runner/pull/163
[#164]: https://github.com/jjongs2/ticket-runner/pull/164
[#166]: https://github.com/jjongs2/ticket-runner/pull/166
[#170]: https://github.com/jjongs2/ticket-runner/pull/170
[#172]: https://github.com/jjongs2/ticket-runner/pull/172

## 0.4.5 (2026-09-23)

### Fixes

- The Checks now catch uncommitted work left in the worktree and spend the fix budget on it ([#143])
- The implement Stage's review now lands before it answers, and a later answer keeps every earlier Note ([#141])

### After upgrading

- nothing

[#141]: https://github.com/jjongs2/ticket-runner/pull/141
[#143]: https://github.com/jjongs2/ticket-runner/pull/143

## 0.4.4 (2026-09-23)

### Stages

- A Stage runs `claude-opus-5-5` by default, and a Target can set its effort ([#136])

### Hand-off

- A handed-off Ticket resumes from where it stopped, not from the start ([#135])
- The conventions document now says a handed-off Ticket keeps its State file too ([#138])

### After upgrading

- Run `agent-pipeline init` again in every Target; the conventions document's State file line now covers a handed-off Ticket too.

[#135]: https://github.com/jjongs2/ticket-runner/pull/135
[#136]: https://github.com/jjongs2/ticket-runner/pull/136
[#138]: https://github.com/jjongs2/ticket-runner/pull/138

## 0.4.3 (2026-09-22)

### Notes

- A Stage is told the bar a Note must clear before writing one, and the verify Stage holds itself to the same evidence standard ([#129])

### After upgrading

- nothing

[#129]: https://github.com/jjongs2/ticket-runner/pull/129

## 0.4.2 (2026-09-22)

### Notes

- A Note that reaches triage becomes a comment on one standing issue instead of opening a new one ([#124])
- The verify Stage can put what it finds outside the Acceptance Criteria in a Note ([#125])

### Fixes

- The Run lock checks a recycled pid against the holder's recorded start time ([#126])

### After upgrading

- nothing

[#124]: https://github.com/jjongs2/ticket-runner/pull/124
[#125]: https://github.com/jjongs2/ticket-runner/pull/125
[#126]: https://github.com/jjongs2/ticket-runner/pull/126

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

[#110]: https://github.com/jjongs2/ticket-runner/pull/110
[#112]: https://github.com/jjongs2/ticket-runner/pull/112
[#115]: https://github.com/jjongs2/ticket-runner/pull/115
[#117]: https://github.com/jjongs2/ticket-runner/pull/117
[#118]: https://github.com/jjongs2/ticket-runner/pull/118
[#120]: https://github.com/jjongs2/ticket-runner/pull/120

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

[#94]: https://github.com/jjongs2/ticket-runner/pull/94
[#95]: https://github.com/jjongs2/ticket-runner/pull/95
[#100]: https://github.com/jjongs2/ticket-runner/pull/100
[#102]: https://github.com/jjongs2/ticket-runner/pull/102
[#104]: https://github.com/jjongs2/ticket-runner/pull/104
[#106]: https://github.com/jjongs2/ticket-runner/pull/106
[#107]: https://github.com/jjongs2/ticket-runner/pull/107

## 0.3.1 (2026-09-20)

### Stop

- `agent-pipeline stop` finishes the Lanes' Tickets and takes no more; Ctrl+C stays a kill; ADR-0006 ([#88], [#91], [#93])

### Fixes

- A Note stays off a claimed, closed or Spec issue ([#85])
- A rate limit is read off the 429, not the wording ([#87])

### After upgrading

- nothing

[#85]: https://github.com/jjongs2/ticket-runner/pull/85
[#87]: https://github.com/jjongs2/ticket-runner/pull/87
[#88]: https://github.com/jjongs2/ticket-runner/pull/88
[#91]: https://github.com/jjongs2/ticket-runner/pull/91
[#93]: https://github.com/jjongs2/ticket-runner/pull/93

## 0.3.0 (2026-09-19)

### Lanes

- A Run takes `lanes` Tickets at once, default one ([#82], [#83])
- One Lane at a time is in the Landing, rebase to post-merge pull; ADR-0005 ([#77], [#81])
- A Release stops the Run filling Lanes; busy Lanes finish ([#83])
- Ticket log lines start with `#<n>` ([#82])

### After upgrading

- Run `agent-pipeline init` again in every Target; the conventions document gained the Checks-in-parallel line. Keep `lanes` at one where Checks share a port or database.

[#77]: https://github.com/jjongs2/ticket-runner/pull/77
[#81]: https://github.com/jjongs2/ticket-runner/pull/81
[#82]: https://github.com/jjongs2/ticket-runner/pull/82
[#83]: https://github.com/jjongs2/ticket-runner/pull/83

## 0.2.0 (2026-09-18)

### Any Target

- `init` sets a Target up and reports what only a human can ([#71])
- A Run refuses a Target `init` has not set up ([#72])
- A Run works against the Target's Base branch; `baseBranch` overrides ([#70])

### After upgrading

- Run `agent-pipeline init` once in every Target; a Run now refuses one without it.

[#70]: https://github.com/jjongs2/ticket-runner/pull/70
[#71]: https://github.com/jjongs2/ticket-runner/pull/71
[#72]: https://github.com/jjongs2/ticket-runner/pull/72

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

[#41]: https://github.com/jjongs2/ticket-runner/pull/41
[#42]: https://github.com/jjongs2/ticket-runner/pull/42
[#43]: https://github.com/jjongs2/ticket-runner/pull/43
[#45]: https://github.com/jjongs2/ticket-runner/pull/45
[#46]: https://github.com/jjongs2/ticket-runner/pull/46
[#48]: https://github.com/jjongs2/ticket-runner/pull/48
[#49]: https://github.com/jjongs2/ticket-runner/pull/49
[#51]: https://github.com/jjongs2/ticket-runner/pull/51
[#54]: https://github.com/jjongs2/ticket-runner/pull/54
[#56]: https://github.com/jjongs2/ticket-runner/pull/56
[#58]: https://github.com/jjongs2/ticket-runner/pull/58
[#64]: https://github.com/jjongs2/ticket-runner/pull/64
[#67]: https://github.com/jjongs2/ticket-runner/pull/67

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

[#9]: https://github.com/jjongs2/ticket-runner/pull/9
[#14]: https://github.com/jjongs2/ticket-runner/pull/14
[#16]: https://github.com/jjongs2/ticket-runner/pull/16
[#18]: https://github.com/jjongs2/ticket-runner/pull/18
[#20]: https://github.com/jjongs2/ticket-runner/pull/20
[#22]: https://github.com/jjongs2/ticket-runner/pull/22
[#24]: https://github.com/jjongs2/ticket-runner/pull/24
[#25]: https://github.com/jjongs2/ticket-runner/pull/25
[#27]: https://github.com/jjongs2/ticket-runner/pull/27
[#28]: https://github.com/jjongs2/ticket-runner/pull/28
[#30]: https://github.com/jjongs2/ticket-runner/pull/30
[#34]: https://github.com/jjongs2/ticket-runner/pull/34
[#36]: https://github.com/jjongs2/ticket-runner/pull/36
[#39]: https://github.com/jjongs2/ticket-runner/pull/39
