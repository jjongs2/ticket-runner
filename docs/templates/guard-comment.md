<!-- ticket-runner:guard:<reason> -->
**Skipped by ticket-runner.** <Reason sentence>. <Fix sentence>.

Reasons and their two sentences:

- `spec` — This issue has sub-issues, so it is a Spec, not a Ticket; `ready-for-agent` was removed. Its Tickets are picked up individually.
- `no-criteria` — No `- [ ]` acceptance criteria found in the body or comments. Add criteria the verify Stage can grade, then re-run.
- `no-criteria`, on a Ticket whose checkboxes are all ticked — No `- [ ]` acceptance criteria found: all <k> of its checkboxes are already ticked. Untick each criterion not yet done, then re-run. With one ticked checkbox, the first sentence ends: its one checkbox is already ticked.
- `body-only-blockers` — The body lists blockers that have no native `blocked by` edge. Add the edges with `gh issue edit <n> --add-blocked-by <m>`, then re-run.
