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

**Target**:
The repository a Run claims Tickets from and merges into, the one whose working directory the command was started in. The pipeline's own repository is a Target only when the command ran there.
_Avoid_: project, host repo, workspace, target repo, cwd

**Base branch**:
The branch of the Target a Run works against: what it branches a Ticket from, rebases it onto, targets its pull request at, and pulls the main checkout to once it merges. The Target's default branch on GitHub unless the config file names another, and resolved once at the start of a Run.
_Avoid_: default branch, trunk, main, integration branch

**Run**:
One invocation of the pipeline command. Drains the Frontier through its Lanes. Ends when no Lane is busy and the Frontier is empty or every Ticket left on it is blocked, or, once a Ticket has been released, when the last busy Lane comes back.
_Avoid_: session, batch, loop

**Lane**:
One of the places a Run has for a Ticket in progress; the Target's config says how many. A Lane holds one Ticket from Claim to merge, hand-off or Release, and is refilled from the Stranded Tickets first and the Frontier second.
_Avoid_: slot, worker, thread, parallelism

**Landing**:
The stretch of a Ticket from its rebase to the pull of the Base branch after its merge, including any Conflict Stage and the wait for CI. Only one Lane is in it at a time, taken in the order they arrive, so the Base branch cannot move between a Ticket's rebase and its merge. A Ticket that leaves it for a fix Stage rejoins at the back.
_Avoid_: merge queue, tail, critical section, merge lane

**Run lock**:
The PID file that stops two Runs, or a Run and a `ticket`, sharing one Target. Target-wide and held for the whole Run, where a Claim is per-Ticket and lives on GitHub.
_Avoid_: mutex, pidfile

**Target readiness**:
What `agent-pipeline init` must have left in a Target before a Run may start: the two gitignored directories, the conventions document, a `CLAUDE.md` pointing at it, and the six triage labels. Asked for presence, never content. A Run that finds one missing refuses the Target and names `init`, rather than putting it there itself.
_Avoid_: preflight, setup check, validation, guard (a Guard rejects a Candidate, readiness rejects the Target)

**Stage**:
One Claude Code session inside a Run with a single purpose: implement, verify, fix, or resolve a rebase conflict.
_Avoid_: step, phase, task

**Stage mark**:
The `AGENT_PIPELINE_STAGE` variable a Run sets in every Stage's shell. The pipeline refuses to start while it is present, so a Stage cannot start a nested Run. A tripwire, not a sandbox, where the Run lock stops two humans.
_Avoid_: flag, sandbox, guard variable

**Progress comment**:
The one comment a Ticket's Stages share, found by its hidden marker and edited in place so only the first Stage notifies anyone. Carries a row per Stage and nothing a human has to act on.
_Avoid_: status comment, progress update, run comment

**Check**:
A deterministic command the pipeline runs itself to gate a Ticket — tests, typecheck, CI. Never an agent's opinion.
_Avoid_: validation, test run

**Guard**:
A rule that rejects a Candidate before it is claimed, because Planning left it unusable: a Spec offered as a Ticket, no Acceptance Criteria, blockers only the body knows about. It rejects and warns once; it never repairs the issue.
_Avoid_: validation, precondition, check (a Check gates a claimed Ticket, a Guard gates the claim)

**Verify**:
The Stage that adversarially tries to prove a Ticket's Acceptance Criteria are not met, and returns a Verdict. What it finds beside the criteria leaves the session as a Note, because the Verdict has a slot per criterion and none for anything else.
_Avoid_: review, QA, audit

**Conflict Stage**:
The Stage that resolves a rebase conflict, driving the resolving-merge-conflicts skill in the worktree where git stopped. What it left behind is judged by the worktree, not by how the session ended.
_Avoid_: merge Stage, conflict resolution

**Acceptance Criteria**:
The checkbox list in a Ticket's body or comments (triage posts its brief as a comment). One criterion is an unticked task list item at the head of a line — indent, a `-`, `*` or `+` bullet, then `[ ]` — and nothing else is one, however much it reads like a promise. The only thing Verify grades.
_Avoid_: requirements, definition of done

**Verdict**:
The structured result of Verify: one status per criterion (met, unmet, unverifiable) with evidence.
_Avoid_: report, review result, score

**Fix budget**:
The single fix Stage a Ticket is allowed. A failing Check, including one the wall-clock limit killed, an unmet criterion or a red CI spends it, and processing resumes at the Checks — unless the fix Stage came back without committing anything, which ends the Ticket where it stands rather than re-grading a branch nobody touched. A second failure of any kind is a hand-off.
_Avoid_: retry budget, fix limit, second chance

**Release**:
What a rate-limited Stage does to a Ticket instead of handing it to a human: the Claim is undone, `ready-for-agent` goes back on, the branch and worktree stay, and a State file says where to resume. Nothing about the Ticket was wrong, so no Fix budget is spent and nobody is notified. It also stops the Run that made it claiming any more Tickets, because the limit that stopped one Stage will stop the next; the Lanes still busy finish what they hold.
_Avoid_: pause, defer, requeue, unclaim

**Stop**:
What a human asks of a running Run: finish the Tickets its Lanes hold, to merge or hand-off, and take no more — not from the Frontier and not from the Stranded Tickets. Nothing about any Ticket changes, so nothing is written to the board and the exit code is the outcomes' as usual. Not a kill: a killed Run leaves Stranded Tickets, a stopped one leaves none. `agent-pipeline stop` is how one is asked for, in the only way there is: SIGTERM to the process the Run lock names.
_Avoid_: drain (a Run drains the Frontier), pause, cancel, abort, kill, graceful shutdown

**State file**:
What a claimed Ticket keeps under `.agent-pipeline/state/`: the state it reached, its branch, whether the Fix budget was spent, and the pull request if one is open. Written as part of the Claim and updated as the Ticket advances, so it is there for as long as the Ticket is claimed; removed on merge and on hand-off. Its presence makes the Ticket resumable, and the Claim on GitHub says whether the Ticket was released or stranded.
_Avoid_: checkpoint, journal, resume file

**Stranded Ticket**:
A Ticket whose State file is still there while the Ticket still carries this Target's Claim — the Run that claimed it was killed and released nothing. No Frontier can offer one, because it is claimed, so a Run sweeps for them before it computes a Frontier at all and resumes every one in place, a free Lane taking one before anything the Frontier holds.
_Avoid_: orphan, zombie, abandoned Ticket, crashed Ticket, dead Ticket

**Note**:
A finding the implement, verify or fix Stage makes that belongs to another Ticket, or to no Ticket yet. Routed to that Ticket's comments when it is open, unclaimed and not a Spec, and otherwise to the standing Notes issue, the one `needs-triage` issue every Note that cannot reach a Ticket is gathered on as a comment; never acted on in the current Ticket.
_Avoid_: handoff, finding, TODO, side note

### Versions

**Version**:
A number `main` carries as a tag and an installed copy of the pipeline reports. What a Target's conventions document, a Ticket's State file and a Run's transcripts are stamped with, so each can be traced to the pipeline that wrote it. A development checkout reports the last Version and the commit it actually runs, because between two Versions the number alone says nothing.
_Avoid_: release (a Release is what a rate-limited Stage does to a Ticket), build, revision, tag (the tag is where a Version lives, not what it is)

**Version PR**:
The pull request that raises the number and carries the Version notes; its merge is what cuts a Version. Opened by a human with an agent's help: the agent proposes the number by the rule and drafts the notes, and the human's review and merge are the decision, because when a Version is cut is a Planning decision, not something the pipeline infers from what merged.
_Avoid_: release PR, bump PR, version bump

**Version notes**:
What a Version PR says about the Version it cuts: what changed since the last one, grouped for a reader rather than listed per pull request, and what a Target or its human has to do after upgrading. Kept in `CHANGELOG.md`, one section per Version, and published as the body of the Version's GitHub Release.
_Avoid_: release notes, changelog entry, what's changed
