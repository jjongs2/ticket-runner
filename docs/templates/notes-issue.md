Notes from the pipeline

<!-- agent-pipeline:notes-issue -->
**Notes from the pipeline.** Every defect a Stage met outside its own Ticket and
could not post on another one arrives here as a comment: one that named no
Ticket, one whose Ticket would have buried it, and one whose Ticket refused the
comment. Each comment says which Ticket and Stage found it. What is not a defect
— a preference, a refactor, a test that would be nice to have — is not a Note and
never reaches this issue.

Triage empties this issue by hand: promote what deserves a Ticket, record the
promotion in this body, and close the issue once the body accounts for every
comment. The next Note after that opens a fresh one, so only ever one of these is
open.

The standing issue every Note that cannot reach a Ticket becomes a comment on,
labelled `needs-triage` so it sits on the board with everything else awaiting a
human. The first line is the title; the rest is the body.

Opened lazily, by the first Note of a Run that needs one and finds none open, and
written once. The pipeline never touches the body again: what is under it is
comments, and the body is triage's to index as it promotes them.

One issue rather than one per Note, because the same condition is met by Stage
after Stage. A Target that opens an issue every time turns triage into gathering
duplicates: five Notes about one missing config file were five issues, two of
them with identical titles, all five closed against one hand-written Ticket —
and the facets they had each seen separately were what that Ticket's Acceptance
Criteria were made of. So a facet that changes what a reader would do about a
condition already recorded here is still written down, and another instance of
that condition is not; only the artifact they arrive in is one.

Found again by the marker in this body, never by the title. The title is a fast
path: the open `needs-triage` issues carrying it are read first, and one that
carries it without the marker is somebody else's and is never written to. Where
none of them confirms, the rest are read for the marker, so a human who renames
this issue is still found rather than given a second one. The pipeline never
rewrites the title it opened with.

A closed one is never written to. Nothing reopens it: the next Note opens a fresh
issue, which is what closing this one means.

The marker here is the issue's, not a Note's. `note-comment.md` signs every Note
with `<!-- agent-pipeline:note -->`, and a lookup that confused the two would
write Notes into a Note.
