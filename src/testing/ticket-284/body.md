## What to build

`GLOSSARY.md` becomes a glossary and nothing else: each entry says what its term is, in one or two sentences, with the boundary that keeps it apart from its neighbours, and nothing about how the pipeline does it — no procedures, cause lists, invariants, variable names, flags or status codes. A word is listed only when it is coined, or is an ordinary word given a narrower meaning a reader would misread, and its boundary decides something a human or a Stage does; a word that reads right in lowercase is not a term. That leaves 18 terms of today's 38.

What the glossary says about behaviour on the base branch does not disappear. The code stays its authority, and the wiki page whose subject is that mechanism becomes the one place a reader finds it, in English and in Korean:

| Wiki page | Behaviour that today's glossary gives these terms |
|---|---|
| planning | Guard, Candidate, Spec, Ticket, Acceptance Criteria |
| running | Run, Lane, Credential, Spend, Operator, Host |
| ticket-to-merge | Claim, Fix budget, Verdict, Verify, Conflict Stage, Landing, Check, Hand-off, Note, Progress comment |
| stopping-and-resuming | Run lock, State file, Release, Stop, Stranded Ticket |
| installation | Target readiness, Target |
| configuration | Base branch |
| internals | Stage mark, Session mark, Version (its stamps) |

The contributing guide says all of this, says that a term is coined, renamed or redefined only in Planning, says how Korean text writes the words the glossary no longer lists, and says that prose writes pull request in full. Two dropped words are not lowercased but renamed, because the lowercase phrase is not what English says: Version PR becomes release PR, and Version notes becomes release notes. Both are set phrases, and neither is the Release the glossary lists, which is always capitalised.

Decided while grilling, and out of scope here:

- Writing the dropped words in lowercase anywhere but in the text this Ticket itself adds: other Tickets do that, for the pipeline and for the documents.
- ADRs and `CHANGELOG.md`, which record what was true when they were written.
- The `_Avoid_` lines of the terms that stay, and anchors per term.
- A Check that measures the length of a definition.

## Acceptance criteria

- [ ] `GLOSSARY.md` keeps its title and opening line, and its `## Language` section holds exactly the following, headings, terms, order, definitions and `_Avoid_` lines alike:

  ````md
  ### Planning

  **Planning**:
  The human-driven half of the chain — grilling, to-spec, to-tickets, triage. Ends when Tickets exist.
  _Avoid_: design phase, prep

  **Spec**:
  A parent GitHub issue produced by to-spec describing a whole feature. Never implemented directly; only its Tickets are.
  _Avoid_: parent issue, epic, story

  **Ticket**:
  A GitHub issue sized for one implement Stage, produced by to-tickets or triage. It stays a Ticket under any label; `ready-for-agent` only puts it in front of a Run.
  _Avoid_: task, job, issue (when a Ticket is meant), brief

  **Acceptance Criteria**:
  The unticked task list items in a Ticket's body or comments, and the only thing the verify Stage grades. A promise written as prose is not one.
  _Avoid_: requirements, definition of done

  ### Running

  **Target**:
  The repository a Run claims Tickets from and merges into: the one it was started in. The pipeline's own repository is a Target only when a Run is started there.
  _Avoid_: project, host repo, workspace, target repo, cwd

  **Host**:
  The machine a Run executes on: a workstation that outlives the Run, or a cloud VM that lasts as long as the Operator on it.
  _Avoid_: cloud session (a session is a Stage), machine, environment, runner, checkout

  **Operator**:
  The Claude session a human opens on a cloud Host to start a Run, watch it and stop it from the Claude app. Never a Stage, and never the Run itself.
  _Avoid_: cloud session, outer session, driver, supervisor, orchestrator

  **Run**:
  One invocation of the pipeline that works Tickets through its Lanes until it has none left to take or is told to take no more.
  _Avoid_: session, batch, loop

  **Lane**:
  One of the places a Run has for a Ticket in progress, holding one Ticket at a time from its claim to its merge, Hand-off or Release.
  _Avoid_: slot, worker, thread, parallelism

  **Frontier**:
  The open `ready-for-agent` issues nobody has claimed and no open blocker holds back. Where a Run takes new Tickets from; a Stranded Ticket is resumed without passing through it.
  _Avoid_: queue, backlog

  **Stage**:
  One Claude Code session inside a Run with a single purpose: implement, verify, fix, or resolve a rebase conflict.
  _Avoid_: step, phase, task

  **Check**:
  A deterministic command the pipeline runs itself on a Ticket's code to gate it, such as its tests or typecheck. Never an agent's opinion, and never the CI on a pull request, which the pipeline only waits for.
  _Avoid_: validation, test run

  **Landing**:
  The stretch of a Ticket's way from bringing the base branch up to date and rebasing onto it to pulling the base branch after its merge, which only one Lane is in at a time.
  _Avoid_: merge queue, tail, critical section, merge lane

  **Note**:
  A defect met while working a Ticket and recorded where a human will find it instead of being fixed there: one that belongs to another Ticket or to none yet, or one the verify Stage, which fixes nothing, found beside the criteria. Never a preference or a refactor.
  _Avoid_: handoff, finding, TODO, side note

  ### When work stops

  **Hand-off**:
  Giving a claimed Ticket to a human, which is how every ending of one that is neither a merge nor a Release goes. Any work the pipeline did stays where the human, or a later Run they hand it back to, can carry on from it.
  _Avoid_: handover, escalation, bail-out, failure (a Ticket is handed off for reasons that are nobody's defect too)

  **Release**:
  Giving a Ticket back to the pipeline because something outside the Ticket stopped its work, such as a usage limit or a failing base branch. Nothing is said on the Ticket, and a later Run takes it up again.
  _Avoid_: pause, defer, requeue, unclaim

  **Stop**:
  What a human asks of a running Run: finish the Tickets its Lanes hold and take no more. Not a kill, which leaves Stranded Tickets behind.
  _Avoid_: drain (a Run drains the Frontier), pause, cancel, abort, kill, graceful shutdown

  **Stranded Ticket**:
  A Ticket that a Run which never came back left claimed, with the record of how far it got still on the Target's remote. Never on the Frontier, because it is claimed.
  _Avoid_: orphan, zombie, abandoned Ticket, crashed Ticket, dead Ticket
  ````

- [ ] Every statement about behaviour that `GLOSSARY.md` on the base branch makes and the new one does not is stated on the wiki page the table above gives for its term, on the English page and its Korean translation alike; where that page did not state it, this Ticket adds it there.
- [ ] Nothing this Ticket adds to or changes in the wiki contradicts what the code does.
- [ ] In `CONTRIBUTING.md`'s Code section, the line "Name things with the glossary. A concept that needs a new word is a signal to update `GLOSSARY.md` first." reads instead: "Name things with the glossary where a term fits. A capitalised term is coined, renamed or redefined only in Planning, and a Stage edits `GLOSSARY.md` only where an Acceptance Criterion gives the wording. Which words are terms follows the `domain-modeling` skill, applied strictly: a word that reads right in lowercase is not one."
- [ ] `CONTRIBUTING.md`'s Wiki section still makes `GLOSSARY.md` a term's home, and says that a change in behaviour edits the page whose subject is that mechanism, while `GLOSSARY.md` changes only when a term's boundary does.
- [ ] `CONTRIBUTING.md`'s Language section says that Korean text keeps in English a word the glossary does not list where English is what people working in the field say, writes any other in Korean that reads as Korean rather than as a translation, and gives this table as how each word the glossary dropped is written:

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

- [ ] `CONTRIBUTING.md`'s Language section says, for English and Korean text alike: Prose says pull request, never PR; PR stays only where space is tight — a `PR #<n>` reference, a table cell, a label, a name — and in the set phrase release PR.
- [ ] Text this Ticket adds writes none of these in capitals, except where English capitalises any word that opens a sentence: Execution, Candidate, Claim, Base branch, Credential, Spend, Run lock, Target readiness, Stage mark, Session mark, Progress comment, Guard, Verify, Conflict Stage, Verdict, Fix budget, State file, Version, Version PR, Version notes, and the short forms State (for the state file) and Progress (for the progress comment, as in Progress cell). A word that is itself one of the 18 terms the glossary lists keeps its capital inside a dropped term (Run lock, Stage mark, Target readiness, conflict Stage, verify Stage), and an acronym keeps its own case (release PR). Plurals and possessives count as the term.
- [ ] Nothing outside `GLOSSARY.md`, `CONTRIBUTING.md` and the wiki changes.


---
_Generated by [Claude Code](https://claude.ai/code)_

