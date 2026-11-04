# ticket-runner

A tool that drives the mattpocock-skills chain: humans plan, the pipeline executes.

## Language

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
