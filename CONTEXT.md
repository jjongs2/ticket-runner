# agent-pipeline

A tool that drives the mattpocock-skills chain unattended: humans plan, the pipeline executes.

## Language

### Phases

**Planning**:
The human-driven half of the chain — grilling, to-spec, to-tickets, triage. Ends when Tickets exist.
_Avoid_: design phase, prep

**Execution**:
The unattended half — everything from picking a Ticket to merging it. Owned entirely by the pipeline.
_Avoid_: implementation phase, automation

### Work items

**Spec**:
A parent GitHub issue produced by to-spec describing a whole feature. Never implemented directly; only its Tickets are.
_Avoid_: parent issue, epic, story

**Ticket**:
A GitHub issue the pipeline can implement in a single session, produced by to-tickets or triage and labelled ready-for-agent.
_Avoid_: task, job, issue (when a Ticket is meant), brief

**Frontier**:
The set of open, unclaimed Tickets whose blockers are all closed. The only Tickets a Run may pick.
_Avoid_: queue, backlog

**Claim**:
Marking a Ticket as taken by a Run so no other Run picks it.
_Avoid_: lock, checkout

### Pipeline

**Run**:
One invocation of the pipeline command. Drains the Frontier one Ticket at a time.
_Avoid_: session, batch, loop

**Stage**:
One Claude Code session inside a Run with a single purpose: implement, verify, or fix.
_Avoid_: step, phase, task

**Check**:
A deterministic command the pipeline runs itself to gate a Ticket — tests, typecheck, CI. Never an agent's opinion.
_Avoid_: validation, test run

**Verify**:
The Stage that adversarially tries to prove a Ticket's Acceptance Criteria are not met, and returns a Verdict.
_Avoid_: review, QA, audit

**Acceptance Criteria**:
The checkbox list in a Ticket's body or comments (triage posts its brief as a comment). The only thing Verify grades.
_Avoid_: requirements, definition of done

**Verdict**:
The structured result of Verify: one status per criterion (met, unmet, unverifiable) with evidence.
_Avoid_: report, review result, score
