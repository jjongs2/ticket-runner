# One `claude -p` child process per Stage

Every Stage (implement, verify, fix) runs as a separate `claude -p` child process rather than through the Claude Agent SDK or a single long session. User-invoked skills (`disable-model-invocation: true`) cannot be called by another skill or agent, but headless mode expands `/plugin:skill` in the prompt string, so a child process is the only way to drive `/mattpocock-skills:implement` without editing the plugin. Process boundaries also give per-Stage turn and wall-clock limits, structured JSON output via `--json-schema`, and a command a human can paste into a terminal to reproduce a Stage exactly. We pay ~1–2s startup per Stage and lose shared context between Stages, which is acceptable because Stages are designed to be context-free (each reads the Ticket and the branch).

## Amendment: a Stage is bounded by its minutes alone

A turn is one request to the API, whether it reads a file or waits on a three-minute test run, so a count of them says little about how far a Stage got or how long it took. Across 178 implement Stages in the local transcripts of three Targets, a turn took a median 18 s, 9 s at p10 and 27 s at p90. The cap on a Stage's turns stopped two Stages in those transcripts, both well inside their minutes: an implement Stage at 301 turns after 37.8 of its 60 minutes, still editing files and running the tests, and a verify Stage at 81 turns after 15.1 of its 30. The wall-clock limit bounds the same runaway Stage the cap was for: even at the p10 pace, the implement Stage would have reached its cap after 45 minutes, inside its 60.

So a Stage's only limit is its `maxMinutes`. The pipeline passes the session no cap on its turns, the Stage setting that named one is gone, and a config file that still names it is refused at startup as any key this version does not take. The progress comment, which showed each Stage's turns, shows its context instead: the main session's tokens when the Stage ended, and whether it compacted.

The cost is that a Stage looping on short turns now runs until its wall-clock limit, where the cap could have stopped it sooner.
