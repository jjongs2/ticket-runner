## <number> (<yyyy-mm-dd>)

### <group the writer names>

- <what changed, for a reader of the pipeline> ([#<pr>])

### After upgrading

- <what a Target or its human has to do> — or the single word: nothing

[#<pr>]: https://github.com/jjongs2/ticket-runner/pull/<pr>

The Version notes: one section of `CHANGELOG.md`, written in the Version PR and
published as the body of that Version's GitHub Release (ADR-0007). The skill in
`.claude/skills/cut-a-version/` writes it; nothing in the pipeline does.

The `## ` heading is the section's boundary — the check on the Version PR looks
for the number there, and the tag workflow publishes everything under it up to
the next `## ` as the Release body. The date is the day the Version is cut.

`After upgrading` is a fixed heading: always last, always present, and the one
thing a reader of this tool cannot get from the pull request list, because the
pipeline rewrites files in every Target it is set up in. When nothing is asked
of a Target, it says so in one word rather than being left out.

Everything above it is grouped by what changed, in the writer's own words.
Lines are terse: about a dozen words, ending in the pull request numbers the
change landed in. One line per change, not per pull request — three pull
requests that built one thing are one line carrying three numbers.

The numbers are links the notes carry themselves, defined at the end of the
section below `After upgrading`, where the extraction keeps them and nothing
renders them. GitHub turns a bare `#94` into a link only in conversations, and
in a private repository only where the author of the text can read what it
points at: this file is a file, so it never links, and a Release the tag
workflow publishes is written by `github-actions[bot]`, which cannot, so its
numbers come out plain. Written as reference links they read as the same words
wherever the notes are read, and by whoever published them.
