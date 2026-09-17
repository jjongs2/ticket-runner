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

**Candidate**:
An open Ticket labelled ready-for-agent that a Run considered. The Frontier is the candidates left after dropping the claimed and the blocked ones.
_Avoid_: pick, contender

**Claim**:
Marking a Ticket as taken by a Run so no other Run picks it.
_Avoid_: lock, checkout

### Pipeline

**Run**:
One invocation of the pipeline command. Drains the Frontier one Ticket at a time.
_Avoid_: session, batch, loop

**Run lock**:
The PID file that stops two Runs, or a Run and a `ticket`, sharing one repo. Repo-wide and held for the whole Run, where a Claim is per-Ticket and lives on GitHub.
_Avoid_: mutex, pidfile

**Stage**:
One Claude Code session inside a Run with a single purpose: implement, verify, fix, or
resolve a rebase conflict.
_Avoid_: step, phase, task

**Stage mark**:
The `AGENT_PIPELINE_STAGE` variable a Run sets in every Stage's shell. The pipeline refuses to start while it is present, so a Stage cannot start a nested Run. A tripwire, not a sandbox, where the Run lock stops two humans.
_Avoid_: flag, sandbox, guard variable

**Check**:
A deterministic command the pipeline runs itself to gate a Ticket — tests, typecheck, CI. Never an agent's opinion.
_Avoid_: validation, test run

**Guard**:
A rule that rejects a Candidate before it is claimed, because Planning left it unusable: a Spec offered as a Ticket, no Acceptance Criteria, blockers only the body knows about. It rejects and warns once; it never repairs the issue.
_Avoid_: validation, precondition, check (a Check gates a claimed Ticket, a Guard gates the claim)

**Verify**:
The Stage that adversarially tries to prove a Ticket's Acceptance Criteria are not met, and returns a Verdict.
_Avoid_: review, QA, audit

**Conflict Stage**:
The Stage that resolves a rebase conflict, driving the resolving-merge-conflicts skill in
the worktree where git stopped. What it left behind is judged by the worktree, not by how
the session ended.
_Avoid_: merge Stage, conflict resolution

**Acceptance Criteria**:
The checkbox list in a Ticket's body or comments (triage posts its brief as a comment). The only thing Verify grades.
_Avoid_: requirements, definition of done

**Verdict**:
The structured result of Verify: one status per criterion (met, unmet, unverifiable) with evidence.
_Avoid_: report, review result, score

**Fix budget**:
The single fix Stage a Ticket is allowed. A failing Check, an unmet criterion or a red CI spends it, and processing resumes at the Checks; a second failure of any kind is a hand-off.
_Avoid_: retry budget, fix limit, second chance

**Note**:
A finding a Stage makes that belongs to another Ticket, or to no Ticket yet. Routed to that Ticket's comments or to a new needs-triage issue; never acted on in the current Ticket.
_Avoid_: handoff, finding, TODO, side note
