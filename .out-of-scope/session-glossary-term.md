# "Session" as a glossary term

This project does not define *session* in `CONTEXT.md`, and does not replace
the word with *Stage* where the documents and the code comments use it.

## Why this is out of scope

The glossary holds the words this project gives a meaning of its own. *Session*
is not one of them: it is Claude Code's own word for one `claude` process and
the conversation it holds, and every use in the README, ADR-0002, CONTRIBUTING
and the `src/` comments means exactly that. The Stage entry already states the
relation the glossary needs — "One Claude Code session inside a Run with a
single purpose" — so a Stage is one session and a Run holds several. That is
also why *session* sits in the Run entry's _Avoid_ list and not in Stage's: a
Run is not a session, it runs them.

A *Session* entry would give a general word a project-specific definition it
does not need. Replacing the word with *Stage* would lose a distinction the
comments rely on: a Stage is a role in a Ticket's lifecycle (implement, verify,
fix, conflict), while the session is the process that plays it — the thing
with turns, a clock, an exit status and a stdout. A comment about how the
process ended, what it printed or how many turns it used is about the session,
not about the Stage.

## Prior requests

- #21 — "The word session is avoided in the glossary but used for a Stage"
