<note title>

From #<origin> <stage>

<note>

The issue a Note opens when it names no Ticket, labelled `needs-triage` so the
triage on-ramp picks it up. The first line is the title; the rest is the body.

The title is derived from the Note rather than asked for: the first sentence of
it, trimmed to fit an issue list. Triage is what turns a Note into a Ticket, so
the title only has to be good enough to be read.

The body carries the Note whole, under the same `From #<origin> <stage>` line
the Note comment uses, and with the same `- [ ]` escaping — a fresh issue with
checkboxes in it would pass the `no-criteria` guard and be picked up as a Ticket
nobody wrote.

There is no marker: an issue is found by its label, not by a hidden comment.
