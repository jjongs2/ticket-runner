## <number> (<yyyy-mm-dd>)

<one sentence: what this Version is, for a reader deciding whether to upgrade>

### <group the writer names>

- <what changed, for a reader of the pipeline> ([#<pr>])

### After upgrading

1. <a step a Target or its human takes before `init`>
2. Run `ticket-runner init` in each Target, then commit and push what it writes<: what it now writes differently>
3. <a step a Target or its human takes after `init`>

[#<pr>]: https://github.com/jjongs2/ticket-runner/pull/<pr>

The Version notes: one section of `CHANGELOG.md`, written in the Version PR and
published as the body of that Version's GitHub Release (ADR-0007). The skill in
`.claude/skills/cut-a-version/` writes it; nothing in the pipeline does.

The `## ` heading is the section's boundary — the check on the Version PR looks
for the number there, and the tag workflow publishes everything under it up to
the next `## ` as the Release body. The date is the day the Version is cut.

Under the heading, one sentence says what the Version is before any group lists
a change: the change that matters most to a reader, or the thread several share.
It names no pull request; the lines below carry them. Sections cut before this
sentence was asked for have none.

`After upgrading` is a fixed heading: always last, always present, and the one
thing a reader of this tool cannot get from the pull request list, because the
pipeline rewrites files in every Target it is set up in. It always includes
running `init` in each Target and committing and pushing what it writes, even
when nothing else changed: each Version stamps a new number, and a Target's
conventions document keeps the old one until `init` rewrites it. Until then a
Run there warns to run `init`, and an Operator installs the Version the
document is stamped with on a cloud Host, which so stays on the old one. Whatever else a Target or its
human must do takes its place before or after that step, in the order the
steps must run; a step nothing asks for is left out. Sections cut before this
was asked for may say `nothing`.

Everything between the sentence and it is grouped by what changed, in the
writer's own words.
Lines are terse, because the reader is deciding whether to upgrade and the pull
request is one click away: about a dozen words, ending in the pull request
numbers the change landed in. A line says what changed; the why and the how
stay in the pull request. One line per change, not per pull request — three
pull requests that built one thing are one line carrying three numbers.

The numbers are links the notes carry themselves, defined at the end of the
section below `After upgrading`, where the extraction keeps them and nothing
renders them. GitHub turns a bare `#94` into a link only in conversations, and
in a private repository only where the author of the text can read what it
points at: this file is a file, so it never links, and a Release the tag
workflow publishes is written by `github-actions[bot]`, which cannot, so its
numbers come out plain. Written as reference links they read as the same words
wherever the notes are read, and by whoever published them.
