<note title>

From #<origin> <stage>

<note>

The issue a Note opens when it names no Ticket, labelled `needs-triage` so the
triage on-ramp picks it up. The first line is the title; the rest is the body.

A Note that names the Ticket its own Stage is working on comes here too. That
Ticket is about to be closed by the Run that made the Note, and a comment on it
would be filed under work that is finished.

So does a Note whose Ticket nobody would read again: one that is closed, one
that is claimed — another Lane of this Run, another Run, a human — whose Stage
read the Ticket when it started and will close it when it lands, or a Spec,
which is never implemented at all. Each of these takes a comment without
complaint, which is why the pipeline checks first. That one's provenance line
carries the number and the reason: `From #<origin> <stage>, meant for #<n>,
which is claimed` (or `is closed`, `is a Spec`).

So does a Note whose Ticket refused the comment — a number the Stage invented,
an issue somebody locked. That one's provenance line carries the number it was
reaching for: `From #<origin> <stage>, meant for #<n>, which would not take the
comment`. The queue is the fallback for every Note, because the one outcome
worth preventing is a finding going nowhere.

The title is derived from the Note rather than asked for: the first sentence of
it, trimmed to fit an issue list. Triage is what turns a Note into a Ticket, so
the title only has to be good enough to be read. The Stage is told as much, and
asked to open with one short sentence that names the finding: a title cut off
mid-thought is read in every issue list until triage renames it.

The body carries the Note whole, under the same `From #<origin> <stage>` line
the Note comment uses, and with the same `- [ ]` escaping — a fresh issue with
checkboxes in it would pass the `no-criteria` guard and be picked up as a Ticket
nobody wrote.

There is no marker: an issue is found by its label, not by a hidden comment.
