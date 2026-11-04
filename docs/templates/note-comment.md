<!-- ticket-runner:note -->
From #<origin> <stage>

**<summary>**

**Evidence**: <evidence>

**Impact**: <impact>

**Next**: <next>

One Note, as a comment. On the Ticket it names when that Ticket is open,
unclaimed and not a Spec; otherwise on the standing Notes issue
(`notes-issue.md`), which is where every Note that cannot reach a Ticket goes. A
comment of its own rather than a row in the progress comment: a Note is for a
human to act on, so it is worth the notification.

The marker is the first line, as it is on every pipeline comment. Nothing finds
this one again — a Stage that notices the same thing twice says it twice — but a
reader who meets an unexplained comment on a Ticket nobody claimed can tell who
wrote it.

`<origin>` is the Ticket whose Stage made the finding and `<stage>` is that
Stage's name, so the transcript that produced the Note can be found under
`.ticket-runner/runs/`.

A Note that was meant for a Ticket and reached the standing Notes issue instead
carries the number it was reaching for, and why that Ticket did not get it:

```
From #<origin> <stage>, meant for #<n>, which is claimed
```

`is closed`, `is a Spec` and `is claimed` are the three Tickets nobody would read
the comment on — one that is finished, one that is never implemented, one another
Lane, another Run or a human is already on. `would not take the comment` is the
fourth variant, for a number the Stage invented or an issue somebody locked: the
one reason the pipeline cannot name. Without that line a finding about #7, read
on the standing issue, has lost the only thing that placed it.

The rest is the Note in its parts, each a field the Stage fills in. `<summary>`
is one short sentence naming the defect, in bold as a paragraph of its own, and
folded onto one line so a line break inside it cannot undo the bold.
`<evidence>` is where the defect is and what shows it is real: what was run or
read, what was expected and what came back. `<impact>` is what breaks, and for
whom. `<next>` is the fix, or the decision a human has to take before anyone can
fix it. Each part sits under a label of its own so a triager finds the evidence
without reading the whole Note, and tells one that waits on a decision from one
that only needs a Ticket. A part the Stage left out or left blank is left out
of the comment, label and all; `next` is the one the Stage is allowed to leave
out, and a Note with no summary is not posted at all.

```
<!-- ticket-runner:note -->
From #12 verify

**`tool sync --help` prints a dump in place of its help text.**

**Evidence**: the subcommand's help string contains a literal `50%`, which argparse reads as %-formatting. `tool sync --help` prints the action dict mid-sentence. The string is at src/cli/sync.py:40 and is the same on main.

**Impact**: every reader of that help text.

**Next**: write it as `50%%`.
```

## The pipeline's own Note

One Note no Stage writes: the pipeline's, when a Ticket is released over a
failing Base branch. A Check failed on the Ticket's branch, or CI failed on its
pull request, and the pipeline ran the Check commands in a clean worktree at
the branch's merge-base with the Base branch, where one failed too. It always
goes to the standing Notes issue, once per Run per merge-base commit, however
many Tickets that commit releases:

````
<!-- ticket-runner:note -->
From the pipeline, releasing #<origin> at <checks|ci>

**The Base branch `<base>` fails `<command>`.**

**Evidence**: `<command>` <failed|timed out> in a clean worktree at <commit>, the merge-base of `<branch>` with `<base>`. The tail of its output:

```
<the last lines the command printed>
```

The branch's own failure, which need not be the same: `<command>` <failed|timed out> on `<branch>`. The tail of the branch's output:

```
<the last lines it printed on the branch>
```

**Impact**: every Ticket whose branch inherits <commit> fails the same Check. #<origin> was released with its Fix budget as it was, and the Run claimed no more Tickets.

**Next**: mend `<command>` on `<base>`. The next Run takes the released Tickets up again from their State files, rebased onto `<base>` before their Checks.
````

`<checks|ci>` is `checks` when the Check failed on the branch and `ci` when CI
did.

The branch's own failure is quoted beside the merge-base's because only the
command is compared: a branch that fails it differently, a timing test that
ran slow say, is released all the same, and without its output here nothing a
human can read says how it failed. It is the failure of the Ticket that posts
the Note; a Ticket released later in the Run over the same commit adds
nothing. For a failure at CI that paragraph reads instead:

````
The branch's own failure, which need not be the same: CI on the pull request from `<branch>` reported <the checks CI reported red>. The tail of the failing jobs' logs:

```
<the failing jobs' logs, as a fix Stage would be handed them>
```
````

The logs are the text a fix Stage is given, each a job's name and its tail, at
most three jobs, so they are not cut again: only trimmed and, like every
quote here, their checkboxes escaped. When no failing check was an Actions job,
the sentence ends `No failing job had a log to quote.` where they would be
introduced.

`<commit>` is the full commit, so it can be checked out as it is. The tail is
the one a CI log excerpt keeps: the last 40 lines the command printed, and no
more than their last 4,000 characters, so long lines cannot push the Note past
what GitHub takes in a comment. When it leaves anything out, its first line
says what, such as `… (20 earlier lines omitted)` or, for one line longer than
the cap, `… (the start of this line omitted)`. It sits in a fence longer than
any run of backticks in it; it is the pipeline's own words around it, so only
the tail has its checkboxes escaped. A command that printed nothing has no
fence, and its sentence ends `It printed nothing.` where the tail would be
introduced. The branch's tail is cut, fenced and escaped the same way, in a
fence of its own.

Every part of a Stage's Note is the Stage's own words, with one edit: a `- [ ]`
at the start of a list item is escaped to `- \[ \]`. An unescaped one would read as an Acceptance
Criterion, and the guards, the Verdict and the tick-on-merge all take a Ticket's
checkboxes at face value.
