# ticket-runner

A tool that drives the mattpocock-skills chain: humans plan, the pipeline executes.

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

**Host**:
The machine a Run executes on: a workstation that outlives the Run, or a cloud VM discarded when the Run ends. Every Host runs the same Run against the same Target, and at most one Run holds a Target at a time, whichever Host it is on. The Claim on GitHub carries the same user whichever Host made it, so nothing on the board says where a Run ran.
_Avoid_: cloud session (a session is a Stage), machine, environment, runner, checkout

**Operator**:
The Claude session a human opens on a cloud Host to run a Run for them, and to watch and steer it from the app. It readies the Host with whatever the Host's own setup did not already put there — the pipeline, the plugin the Stages drive, the `gh` the Tracker calls, and the Target's own dependencies in its main checkout, which every worktree's Checks fall back on — then starts the Run, narrowed to the Tickets the human names when they name any, reports what it prints, passes on a Stop, and releases a Run lock a vanished Host left behind when the human asks; everything else a human wants of a Ticket still goes through the board. While its Run holds the Target it leaves the checkout and the worktrees alone. Never a Stage, and never itself the Run.
_Avoid_: cloud session, outer session, driver, supervisor, orchestrator

**Base branch**:
The branch of the Target a Run works against: what it branches a Ticket from, rebases it onto, targets its pull request at, and pulls the main checkout to once it merges. The Target's default branch on GitHub unless the config file names another, and resolved once at the start of a Run.
_Avoid_: default branch, trunk, main, integration branch

**Run**:
One invocation of the pipeline command. Drains the Frontier through its Lanes; a Run given Ticket numbers takes only those, from the Stranded Tickets and the Frontier alike, and leaves every other Ticket as it found it. Ends when no Lane is busy and the Frontier is empty or every Ticket left on it is blocked, or, once a Ticket has been released, when the last busy Lane comes back.
_Avoid_: session, batch, loop

**Lane**:
One of the places a Run has for a Ticket in progress; the Target's config says how many, unless the Run is told otherwise where it starts, because how many a Host can carry is the Host's business, not the Target's. A Lane holds one Ticket from Claim to merge, Hand-off or Release, and is refilled from the Stranded Tickets first and the Frontier second.
_Avoid_: slot, worker, thread, parallelism

**Landing**:
The stretch of a Ticket from bringing the Base branch up to the remote's and rebasing onto it, to the pull of the Base branch after its merge, including any Conflict Stage and the wait for CI. Only one Lane is in it at a time, taken in the order they arrive, so the Base branch cannot move between a Ticket's rebase and its merge. A Ticket that leaves it for a fix Stage rejoins at the back.
_Avoid_: merge queue, tail, critical section, merge lane

**Run lock**:
What stops two Runs sharing one Target, whichever Host each is on. Target-wide and held for the whole Run, where a Claim is per-Ticket. It lives on the Target's GitHub repository, off the board but where a human can see who holds it, and records the Host that holds it, so a Run on that same Host can tell a dead holder from a live one and take the lock over; a lock left by a Run on another Host is never presumed dead, and stays until a human releases it, through an Operator or on GitHub itself. Taking and releasing it removes nothing: it always says either who holds it or that nobody does, and taking it succeeds only from the state the taker last saw.
_Avoid_: mutex, pidfile, lease

**Target readiness**:
What `ticket-runner init` must have left in a Target before a Run may start: the two gitignored directories, the conventions document stamped with a Version, a `CLAUDE.md` pointing at it, the Operator's skill, the six triage labels, and a repository that deletes a pull request's branch when it merges. Before the GitHub items it asks for a `gh` the Host can run, the one thing on the list `init` only reports: a refusal over it names the install first. The same on every Host, so a Target a local Run accepts is one an Operator can run from the app too. Asked for presence, never content. A Run that finds one missing refuses the Target and names `init`, rather than putting it there itself. `ticket-runner remove` takes it out again, with what Runs left behind.
_Avoid_: preflight, setup check, validation, guard (a Guard rejects a Candidate, readiness rejects the Target)

**Stage**:
One Claude Code session inside a Run with a single purpose: implement, verify, fix, or resolve a rebase conflict.
_Avoid_: step, phase, task

**Stage mark**:
The `TICKET_RUNNER_STAGE` variable a Run sets in every Stage's shell. The pipeline refuses to start while it is present, so a Stage cannot start a nested Run. A tripwire, not a sandbox, where the Run lock stops two humans.
_Avoid_: flag, sandbox, guard variable

**Progress comment**:
The one comment a Ticket's Stages share, found by its hidden marker and edited in place so only the first Stage notifies anyone. Carries a section per Run that worked the Ticket, oldest first, each a row per Stage, and nothing a human has to act on.
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
The single fix Stage a Ticket is allowed each time the pipeline takes it up. A worktree holding changes no commit carries, a failing Check (including one the wall-clock limit killed), an unmet criterion or a red CI spends it, and processing resumes at the Checks — unless the fix Stage came back without committing anything, which ends the Ticket where it stands rather than re-grading a branch nobody touched. A second failure of any kind is a Hand-off. A Release carries a spent budget over, having changed nothing about the Ticket; a Hand-off restores it, because the Ticket only comes back through a human's hands and whatever they did to it is what the fresh budget is for.
_Avoid_: retry budget, fix limit, second chance

**Hand-off**:
Giving a Ticket to a human, which is how every ending that is not a merge or a Release goes: the Claim is undone, `ready-for-human` goes on, a comment names the failure and where the work is, and an open pull request is put back into draft. The branch and the State file stay on the Target's remote, with the handed-off Stages' transcripts beside them, since the Host the work was done on may be gone by the time a human looks, so a human who relabels the Ticket `ready-for-agent` hands it back to the pipeline and it carries on from what it reached, rather than paying for the implement Stage a second time. The exception is a Hand-off at setup over a branch the Run refused to branch over: no Stage of it ran there, so there is nothing of the pipeline's to resume and the file goes.
_Avoid_: handover, escalation, bail-out, failure (a Ticket is handed off for reasons that are nobody's defect too)

**Release**:
What a rate-limited Stage does to a Ticket: the Claim is undone, `ready-for-agent` goes back on, and the branch and the State file stay on the Target's remote. The label is the difference from a Hand-off — the pipeline itself takes the next turn, so nothing is commented, nobody is notified and no Fix budget is spent, the Ticket having done nothing wrong. Alone among the endings it also stops the Run that made it claiming any more Tickets, because the limit that stopped one Stage will stop the next; the Lanes still busy finish what they hold.
_Avoid_: pause, defer, requeue, unclaim

**Stop**:
What a human asks of a running Run: finish the Tickets its Lanes hold, to merge or Hand-off, and take no more — not from the Frontier and not from the Stranded Tickets. Nothing about any Ticket changes, so nothing is written to the board and the exit code is the outcomes' as usual. Not a kill: a killed Run leaves Stranded Tickets, a stopped one leaves none. Asked for in the only way there is, SIGTERM to the Run's process, which only the Host it runs on can send: `ticket-runner stop` on that Host, or the Operator on a cloud Host.
_Avoid_: drain (a Run drains the Frontier), pause, cancel, abort, kill, graceful shutdown

**State file**:
What a Ticket keeps on the Target's remote, off the board, for as long as there is work on its branch worth resuming, so a Run on any Host can take the Ticket up where another left it: the state it reached, its branch, whether the Fix budget was spent, the pull request if one is open, and the latest title the implement or fix Stage answered for the whole branch, which names the pull request. Written as part of the Claim, updated as the Ticket advances, and removed when that work is finished or is not the pipeline's to resume — on merge, when the sweep finds the issue closed, when the branch it names has gone from the remote, and on a Hand-off at setup, where the branch in the way is a human's and no Stage of the Run ever ran. A Hand-off from a branch the Run itself worked on leaves the file, as a Release does, so neither costs the Stages already paid for. Where the work is resumed from is the branch on the remote, pushed each time a Stage commits; a Host still holding a worktree of it uses that worktree only if it sits on top of the remote branch, and hands the Ticket off if the two have parted. Its presence makes the Ticket resumable; what the board says decides by which road — still claimed is stranded, `ready-for-agent` comes back through the Frontier, and `ready-for-human` waits, inert, until a human relabels it.
_Avoid_: checkpoint, journal, resume file

**Stranded Ticket**:
A Ticket whose State file is still there while the Ticket still carries this Target's Claim — the Run that claimed it was killed and released nothing. No Frontier can offer one, because it is claimed, so a Run sweeps for them before it computes a Frontier at all and resumes every one, or, in a Run given Ticket numbers, every one of those, from its branch, on whichever Host the sweeping Run is, a free Lane taking one before anything the Frontier holds.
_Avoid_: orphan, zombie, abandoned Ticket, crashed Ticket, dead Ticket

**Note**:
A defect the implement, verify or fix Stage meets that belongs to another Ticket, or to no Ticket yet — something that behaves wrongly or breaks, never a preference, a refactor or a test that would be nice to have. Routed to that Ticket's comments when it is open, unclaimed and not a Spec, and otherwise to the standing Notes issue, the one `needs-triage` issue every Note that cannot reach a Ticket is gathered on as a comment; never acted on in the current Ticket.
_Avoid_: handoff, finding, TODO, side note

### Versions

**Version**:
A number `main` carries as a tag and an installed copy of the pipeline reports. What a Target's conventions document, a Ticket's State file and a Run's transcripts are stamped with, so each can be traced to the pipeline that wrote it. The conventions document's stamp is also the Version an Operator installs on a cloud Host whose own setup installed none; a Host whose setup did install one runs that one, whatever the stamp says. A development checkout reports the last Version and the commit it actually runs, because between two Versions the number alone says nothing.
_Avoid_: release (a Release is what a rate-limited Stage does to a Ticket), build, revision, tag (the tag is where a Version lives, not what it is)

**Version PR**:
The pull request that raises the number and carries the Version notes; its merge is what cuts a Version. Opened by a human with an agent's help: the agent proposes the number by the rule and drafts the notes, and the human's review and merge are the decision, because when a Version is cut is a Planning decision, not something the pipeline infers from what merged.
_Avoid_: release PR, bump PR, version bump

**Version notes**:
What a Version PR says about the Version it cuts: what changed since the last one, grouped for a reader rather than listed per pull request, and what a Target or its human has to do after upgrading. Kept in `CHANGELOG.md`, one section per Version, and published as the body of the Version's GitHub Release.
_Avoid_: release notes, changelog entry, what's changed
