<!-- agent-pipeline:note -->
From #<origin> <stage>

<note>

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
`.agent-pipeline/runs/`.

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

The note is the Stage's own words, with one edit: a `- [ ]` at the start of a
list item is escaped to `- \[ \]`. An unescaped one would read as an Acceptance
Criterion, and the guards, the Verdict and the tick-on-merge all take a Ticket's
checkboxes at face value.
