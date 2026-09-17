<!-- agent-pipeline:guard:<reason> -->
**Skipped by agent-pipeline.** <Reason sentence>. <Fix sentence>.

Reasons and their two sentences:

- `spec` — This issue has sub-issues, so it is a Spec, not a Ticket; `ready-for-agent` was removed. Its Tickets are picked up individually.
- `no-criteria` — No `- [ ]` acceptance criteria found in the body or comments. Add criteria the verify Stage can grade, then re-run.
- `body-only-blockers` — The body lists blockers that have no native `blocked by` edge. Add the edges with `gh issue edit <n> --add-blocked-by <m>`, then re-run.
