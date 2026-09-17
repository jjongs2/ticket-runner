<!-- agent-pipeline:note -->
From #<origin> <stage>

<note>

One Note, posted on the Ticket it names. A comment of its own rather than a row
in the progress comment: a Note is for a human to act on, so it is worth the
notification, and it belongs to a Ticket the Run is not otherwise touching.

The marker is the first line, as it is on every pipeline comment. Nothing finds
this one again — a Stage that notices the same thing twice says it twice — but a
reader who meets an unexplained comment on a Ticket nobody claimed can tell who
wrote it.

`<origin>` is the Ticket whose Stage made the finding and `<stage>` is that
Stage's name, so the transcript that produced the Note can be found under
`.agent-pipeline/runs/`.

The note is the Stage's own words, with one edit: a `- [ ]` at the start of a
list item is escaped to `- \[ \]`. An unescaped one would read as an Acceptance
Criterion, and the guards, the Verdict and the tick-on-merge all take a Ticket's
checkboxes at face value.
