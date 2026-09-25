import { describe, expect, it } from "vitest";
import { UNCHECKED_BOX } from "./acceptance-criteria.js";
import {
  HANDOFF_MARKER,
  HANDOFF_TAKEN_LINE,
  NOTES_ISSUE_MARKER,
  NOTES_ISSUE_TITLE,
  NOTE_MARKER,
  findMarkedComment,
  findMarkedComments,
  guardComment,
  guardMarker,
  handoffComment,
  handoffTakenComment,
  isNotesIssue,
  noteComment,
  notesIssue,
  pullRequestBody,
  runSummary,
  squashCommit,
} from "./templates.js";
import { parseVerdict } from "./verdict.js";

const verdict = parseVerdict({
  criteria: [
    { text: "tests pass", status: "met", evidence: "npm test green" },
    { text: "docs updated", status: "unverifiable", evidence: "no way to tell" },
  ],
  pass: true,
});

/** The Version the Run ran, which its summary is headed with. */
const VERSION = "0.4.0+331d79c";

describe("pullRequestBody", () => {
  it("starts with Closes #<n> on its own line so the merge closes the Ticket", () => {
    const body = pullRequestBody({ ticket: 2, verdict, runId: "r1" });

    expect(body.split("\n")[0]).toBe("Closes #2");
  });

  it("summarises the Verdict by status count", () => {
    const body = pullRequestBody({ ticket: 2, verdict, runId: "r1" });

    expect(body).toContain("**Verdict:** 1 met · 0 unmet · 1 unverifiable");
  });

  it("lists every criterion, with evidence for the ones not met", () => {
    const body = pullRequestBody({ ticket: 2, verdict, runId: "r1" });

    expect(body).toContain("- ✅ tests pass");
    expect(body).toContain("- ❓ docs updated — no way to tell");
  });

  it("points at the transcripts for the Run", () => {
    const body = pullRequestBody({ ticket: 2, verdict, runId: "r1" });

    expect(body).toContain("Run `r1` · transcripts in `.agent-pipeline/runs/r1/2/`");
  });
});

describe("squashCommit", () => {
  const commit = () =>
    squashCommit({
      ticket: 2,
      pullRequest: 100,
      title: "feat(cli): add a flag",
      verdict,
      commits: ["feat(cli): add a flag (#2)", "docs: write it down (#2)"],
      coAuthors: [],
    });

  it("uses the pull request title as the subject and appends the PR number as GitHub would", () => {
    expect(commit().subject).toBe("feat(cli): add a flag (#100)");
  });

  it("carries the branch's co-authors as trailers at the end of the body", () => {
    const body = squashCommit({
      ticket: 2,
      pullRequest: 100,
      title: "feat(cli): add a flag",
      verdict,
      commits: ["feat(cli): add a flag (#2)"],
      coAuthors: ["Claude Opus 5 <noreply@anthropic.com>", "Pat <pat@example.com>"],
    }).body;

    expect(body.endsWith(
      [
        "- feat(cli): add a flag (#2)",
        "",
        "Co-authored-by: Claude Opus 5 <noreply@anthropic.com>",
        "Co-authored-by: Pat <pat@example.com>",
        "",
      ].join("\n"),
    )).toBe(true);
  });

  it("opens the body with Closes, then the Verdict counts, then the branch commits in order", () => {
    expect(commit().body).toBe(
      [
        "Closes #2",
        "",
        "Verdict: 1 met · 0 unmet · 1 unverifiable",
        "",
        "- feat(cli): add a flag (#2)",
        "- docs: write it down (#2)",
        "",
      ].join("\n"),
    );
  });

  it("carries no HTML and no evidence: git log renders neither", () => {
    const body = commit().body;

    expect(body).not.toContain("<");
    expect(body).not.toContain("no way to tell");
  });
});

describe("handoffComment", () => {
  const base = {
    stage: "verify" as const,
    failure: "1 criterion unmet",
    branch: "agent/2-skeleton",
    worktree: "/repo/.worktrees/ticket-2",
    evidence: "docs updated — nothing written",
  };

  it("starts with the marker line so the pipeline finds its own comment", () => {
    expect(handoffComment(base).split("\n")[0]).toBe(HANDOFF_MARKER);
  });

  it("names the stage, failure, branch and worktree", () => {
    const comment = handoffComment(base);

    expect(comment).toContain("Failed at **verify**");
    expect(comment).toContain("- Failure: 1 criterion unmet");
    expect(comment).toContain("Branch `agent/2-skeleton`");
    expect(comment).toContain("worktree `/repo/.worktrees/ticket-2`");
  });

  it("omits the worktree clause when the Ticket failed before it had one", () => {
    const { worktree, ...beforeSetup } = base;

    const comment = handoffComment(beforeSetup);

    expect(comment).toContain("- Branch `agent/2-skeleton`");
    expect(comment).not.toContain(worktree);
    expect(comment).not.toContain("worktree");
  });

  it("names the draft PR when one was opened", () => {
    expect(handoffComment({ ...base, pullRequest: 12 })).toContain("PR #12 (draft)");
  });

  it("says the branch is on the remote when it is, where it outlives this Host", () => {
    expect(handoffComment({ ...base, onRemote: true })).toContain(
      "- Branch `agent/2-skeleton` on the remote · worktree",
    );
    expect(handoffComment(base)).not.toContain("on the remote");
  });

  it("names where the Stages' transcripts were kept, on its own line", () => {
    const comment = handoffComment({
      ...base,
      transcripts: { branch: "agent-pipeline/state", path: "ticket-2/run-1/" },
    });

    expect(comment).toContain(
      "- Transcripts: `ticket-2/run-1/` on the `agent-pipeline/state` branch",
    );
    expect(handoffComment(base)).not.toContain("Transcripts");
  });

  it("omits the PR clause when no PR exists", () => {
    expect(handoffComment(base)).not.toContain("PR #");
  });

  it("folds the evidence away in a details block", () => {
    const comment = handoffComment(base);

    expect(comment).toContain("<details><summary>Evidence</summary>");
    expect(comment).toContain("docs updated — nothing written");
  });

  it("omits the details block when there is no evidence", () => {
    expect(handoffComment({ ...base, evidence: "" })).not.toContain("<details>");
  });

  it("says so when the Ticket had already spent its fix budget", () => {
    expect(handoffComment({ ...base, fixUsed: true })).toContain(
      "Failed at **verify**, after the fix budget was used.",
    );
  });

  it("says nothing about the budget when no fix Stage ran", () => {
    expect(handoffComment(base)).toContain("Failed at **verify**.");
    expect(handoffComment(base)).not.toMatch(/fix budget/i);
  });
});

describe("findMarkedComments", () => {
  it("gives every comment wearing the marker, oldest first", () => {
    const comments = [
      { id: "c1", body: `${HANDOFF_MARKER}\nfirst` },
      { id: "c2", body: "a human" },
      { id: "c3", body: `${HANDOFF_MARKER}\nsecond` },
    ];

    expect(findMarkedComments(comments, HANDOFF_MARKER).map(({ id }) => id)).toEqual([
      "c1",
      "c3",
    ]);
  });

  it("gives none when the marker is not the first line of any comment", () => {
    expect(findMarkedComments([{ body: `quoting ${HANDOFF_MARKER}` }], HANDOFF_MARKER)).toEqual(
      [],
    );
  });
});

describe("findMarkedComment", () => {
  it("gives the newest of several, not the oldest", () => {
    const comments = [
      { id: "c1", body: `${HANDOFF_MARKER}\nfirst` },
      { id: "c2", body: "a human" },
      { id: "c3", body: `${HANDOFF_MARKER}\nsecond` },
    ];

    expect(findMarkedComment(comments, HANDOFF_MARKER)?.id).toBe("c3");
  });

  it("gives nothing when no comment wears the marker", () => {
    expect(findMarkedComment([{ id: "c1", body: "a human" }], HANDOFF_MARKER)).toBeUndefined();
  });
});

describe("handoffTakenComment", () => {
  const handoff = handoffComment({
    stage: "verify",
    failure: "1 criterion unmet",
    branch: "agent/2-skeleton",
    evidence: "docs updated — nothing written",
  });

  it("puts the line under the marker, above the failure it qualifies", () => {
    expect(handoffTakenComment(handoff)?.split("\n").slice(0, 3)).toEqual([
      HANDOFF_MARKER,
      HANDOFF_TAKEN_LINE,
      "",
    ]);
  });

  it("changes nothing else about the comment", () => {
    const marked = handoffTakenComment(handoff) ?? "";

    expect(marked.replace(`${HANDOFF_TAKEN_LINE}\n\n`, "")).toBe(handoff);
  });

  it("gives nothing back for a comment that already carries the line", () => {
    expect(handoffTakenComment(handoffTakenComment(handoff) ?? "")).toBeUndefined();
  });

  it("marks a hand-off whose evidence only quotes the line", () => {
    const quoting = handoffComment({
      stage: "checks",
      failure: "`npm test` failed",
      branch: "agent/2-skeleton",
      evidence: `a doc under test reads ${HANDOFF_TAKEN_LINE}`,
    });

    expect(handoffTakenComment(quoting)?.split("\n")[1]).toBe(HANDOFF_TAKEN_LINE);
  });
});

describe("guardComment", () => {
  it("opens with the marker the pipeline finds its own warning by", () => {
    expect(guardComment("spec").split("\n")[0]).toBe("<!-- agent-pipeline:guard:spec -->");
  });

  it("gives a marker per reason, so one warning does not silence another", () => {
    expect(guardMarker("no-criteria")).not.toBe(guardMarker("body-only-blockers"));
  });

  it("says a Spec was treated as one and that the label is gone", () => {
    const comment = guardComment("spec");

    expect(comment).toContain("**Skipped by agent-pipeline.**");
    expect(comment).toContain("it is a Spec, not a Ticket");
    expect(comment).toContain("`ready-for-agent` was removed");
  });

  it("tells a criteria-less Ticket what verify needs", () => {
    expect(guardComment("no-criteria")).toContain(
      "No `- [ ]` acceptance criteria found in the body or comments.",
    );
  });

  it("tells a body-only blocker how to make the edge native", () => {
    expect(guardComment("body-only-blockers")).toContain("--add-blocked-by");
  });
});

describe("runSummary", () => {
  const merged = {
    outcome: "merged" as const,
    ticket: 3,
    title: "Run: drain the Frontier",
    branch: "agent/3-run-drain-the-frontier",
    pullRequest: 12,
    notes: [],
  };
  const handed = {
    outcome: "handed-off" as const,
    ticket: 5,
    title: "Fix Stage with a single retry",
    branch: "agent/5-fix-stage",
    stage: "verify" as const,
    failure: "1 unmet",
    notes: [],
  };
  const released = {
    outcome: "released" as const,
    ticket: 6,
    title: "Rebase conflict resolution",
    branch: "agent/6-rebase-conflict-resolution",
    stage: "implement" as const,
    notes: [],
  };

  it("heads the summary with the Version, the Run and how long it took", () => {
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 42 * 60_000,
      outcomes: [],
      stop: { reason: "frontier", blocked: [] },
    });

    expect(summary.split("\n")[0]).toBe(`agent-pipeline ${VERSION} run r1 · 42m`);
  });

  /**
   * Above the header rather than below it: a Run that has been going all night
   * ends in a summary the human scrolls back to, and the line they most need
   * out of it is the one saying the pipeline they ran is not the current one.
   */
  it("puts the newer-Version line at the head, above the header", () => {
    const newer = "A newer Version is out: 0.5.0, and this is 0.4.0 — upgrade.";
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [],
      newer,
      stop: { reason: "frontier", blocked: [] },
    });

    const [first, second] = summary.split("\n");
    expect(first).toBe(newer);
    expect(second).toBe(`agent-pipeline ${VERSION} run r1 · 0m`);
  });

  it("heads the summary with the Run where no newer Version is out", () => {
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [],
      stop: { reason: "frontier", blocked: [] },
    });

    expect(summary.split("\n")[0]).toBe(`agent-pipeline ${VERSION} run r1 · 0m`);
  });

  it("lists merged, handed-off and skipped Tickets by number", () => {
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [merged, handed],
      stop: { reason: "frontier", blocked: [9] },
    });

    expect(summary).toContain("  merged   #3 Run: drain the Frontier (PR #12)");
    expect(summary).toContain("  handed   #5 Fix Stage with a single retry · verify · 1 unmet");
    expect(summary).toContain("  skipped  #9 blocked");
  });

  it("says where the rate limit landed on a released Ticket", () => {
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [released],
      stop: { reason: "rate-limited" },
    });

    expect(summary).toContain("  released #6 Rebase conflict resolution · rate limit at implement");
  });

  it("names the guard that passed a candidate over", () => {
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [
        { outcome: "skipped", ticket: 7, title: "Progress comment", reason: "no-criteria" },
      ],
      stop: { reason: "frontier", blocked: [9] },
    });

    expect(summary).toContain("  skipped  #7 no-criteria");
    expect(summary).toContain("  skipped  #9 blocked");
  });

  it("says the Frontier is empty when nothing was left blocked", () => {
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [merged],
      stop: { reason: "frontier", blocked: [] },
    });

    expect(summary.trimEnd().split("\n").at(-1)).toBe("Frontier empty.");
  });

  it("says the Frontier is blocked when candidates were held back", () => {
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [],
      stop: { reason: "frontier", blocked: [9] },
    });

    expect(summary.trimEnd().split("\n").at(-1)).toBe("Frontier blocked.");
  });

  it("says the rate limit stopped a Run a Release ended", () => {
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [released],
      stop: { reason: "rate-limited" },
    });

    expect(summary.trimEnd().split("\n").at(-1)).toBe("Rate limited.");
  });

  it("reports nothing but the released Ticket when the rate limit stopped the Run", () => {
    // A Run stopped this way cannot say a candidate was held back all Run, so
    // the stop carries no candidates to skip and the summary skips none.
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [released],
      stop: { reason: "rate-limited" },
    });

    expect(summary).not.toContain("skipped");
  });

  it("says when a Stop arrived and what its Lanes were finishing", () => {
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [merged, released],
      stop: { reason: "stopped", at: "2026-09-20T22:07:13.000Z", busy: [3, 6] },
    });

    expect(summary.trimEnd().split("\n").at(-1)).toBe("Stopped at 22:07 · finishing #3 #6.");
  });

  it("says no Lane was busy when the Stop arrived to an idle Run", () => {
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [],
      stop: { reason: "stopped", at: "2026-09-20T22:07:13.000Z", busy: [] },
    });

    expect(summary.trimEnd().split("\n").at(-1)).toBe("Stopped at 22:07 · nothing to finish.");
  });

  it("reports nothing but its own Lanes when a Stop ended the Run", () => {
    // Like a Run the limit stopped, it ended before it could say a candidate
    // was held back all Run, so it says nothing about one.
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [merged],
      stop: { reason: "stopped", at: "2026-09-20T22:07:13.000Z", busy: [3] },
    });

    expect(summary).not.toContain("skipped");
  });

  it("says so when a Run found nothing to take", () => {
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [],
      stop: { reason: "frontier", blocked: [] },
    });

    expect(summary).toContain("  nothing to do");
  });

  it("claims nothing about the Frontier when one Ticket was named", () => {
    const summary = runSummary({ version: VERSION, runId: "r1", durationMs: 0, outcomes: [merged] });

    expect(summary.trimEnd().split("\n").at(-1)).toBe(
      "  merged   #3 Run: drain the Frontier (PR #12)",
    );
  });
});

describe("noteComment", () => {
  const subject = { origin: 10, stage: "implement" as const, note: "the help text drifts" };

  it("opens with the marker, then where the Note came from", () => {
    expect(noteComment(subject).split("\n").slice(0, 2)).toEqual([
      NOTE_MARKER,
      "From #10 implement",
    ]);
  });

  it("carries the Note under it", () => {
    expect(noteComment(subject)).toBe(
      `${NOTE_MARKER}\nFrom #10 implement\n\nthe help text drifts\n`,
    );
  });

  it("defuses a checkbox so no guard reads it as Acceptance Criteria", () => {
    const comment = noteComment({ ...subject, note: "- [ ] rename the flag" });

    expect(comment).toContain("- \\[ \\] rename the flag");
    expect(new RegExp(UNCHECKED_BOX, "m").test(comment)).toBe(false);
  });
});

describe("a Note that fell back to the standing Notes issue", () => {
  const subject = {
    origin: 10,
    stage: "fix" as const,
    note: "Nothing cleans up abandoned worktrees. A Run leaks one per hand-off.",
  };

  it("names the Ticket it was meant for, and why that Ticket did not get it", () => {
    const comment = noteComment({ ...subject, intended: 7, because: "is claimed" });

    expect(comment.split("\n")[1]).toBe("From #10 fix, meant for #7, which is claimed");
  });

  it("says only that the Ticket refused it when there is no reason to give", () => {
    const comment = noteComment({ ...subject, intended: 404 });

    expect(comment.split("\n")[1]).toBe(
      "From #10 fix, meant for #404, which would not take the comment",
    );
  });

  it("carries the Note under the provenance, checkboxes defused", () => {
    const comment = noteComment({ ...subject, intended: 7, note: "todo\n- [ ] one" });

    expect(comment).toContain("- \\[ \\] one");
    expect(new RegExp(UNCHECKED_BOX, "m").test(comment)).toBe(false);
  });
});

describe("notesIssue", () => {
  it("opens under the one fixed title", () => {
    expect(notesIssue().title).toBe(NOTES_ISSUE_TITLE);
  });

  it("carries the marker it is found again by, on the first line of the body", () => {
    expect(notesIssue().body.split("\n")[0]).toBe(NOTES_ISSUE_MARKER);
  });

  it("is not signed with the Note comments' own marker", () => {
    expect(notesIssue().body).not.toContain(NOTE_MARKER);
  });

  it("tells triage what the issue is and how it is emptied", () => {
    const body = notesIssue().body;

    expect(body).toContain("arrives here as a comment");
    expect(body).toContain("close the issue");
  });

  it("recognises its own body again, and nothing else", () => {
    expect(isNotesIssue(notesIssue().body)).toBe(true);
    expect(isNotesIssue("Notes from the pipeline\n\nsomething a human wrote")).toBe(false);
    expect(isNotesIssue(`${NOTE_MARKER}\nFrom #10 fix\n`)).toBe(false);
  });
});

describe("Notes in a Run summary", () => {
  const merged = {
    outcome: "merged" as const,
    ticket: 3,
    title: "Run: drain the Frontier",
    branch: "agent/3-run-drain-the-frontier",
    pullRequest: 12,
    notes: [],
  };
  const handed = {
    outcome: "handed-off" as const,
    ticket: 5,
    title: "Fix Stage with a single retry",
    branch: "agent/5-fix-stage",
    stage: "verify" as const,
    failure: "1 unmet",
    notes: [],
  };
  const note = {
    origin: 3,
    stage: "implement" as const,
    issue: 8,
    opened: false,
    note: "the CLI help drifts from the README",
  };

  it("follows the row of the Ticket whose Stage made it", () => {
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [{ ...merged, notes: [note] }, handed],
    });

    expect(summary.split("\n").slice(2, 5)).toEqual([
      "  merged   #3 Run: drain the Frontier (PR #12)",
      "  noted    #8 comment · from #3 implement · the CLI help drifts from the README",
      "  handed   #5 Fix Stage with a single retry · verify · 1 unmet",
    ]);
  });

  it("reports a Note the verify Stage made the way it reports the others", () => {
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [{ ...merged, notes: [{ ...note, stage: "verify" as const }] }],
    });

    expect(summary).toContain(
      "  noted    #8 comment · from #3 verify · the CLI help drifts from the README",
    );
  });

  it("says when the Note opened an issue of its own", () => {
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [{ ...merged, notes: [{ ...note, issue: 31, opened: true, note: "no cleanup" }] }],
    });

    expect(summary).toContain("  noted    #31 new · from #3 implement · no cleanup");
  });

  it("trims a long Note to one line", () => {
    const long = `worktrees ${"pile ".repeat(40)}up`;
    const summary = runSummary({
      version: VERSION,
      runId: "r1",
      durationMs: 0,
      outcomes: [{ ...merged, notes: [{ ...note, note: long }] }],
    });

    const row = summary.split("\n").find((line) => line.includes("noted")) as string;
    expect(row).not.toContain(long);
    expect(row.length).toBeLessThan(90);
    expect(row.endsWith("\u2026")).toBe(true);
  });

  it("says nothing extra for a Ticket whose Stages found nothing", () => {
    const summary = runSummary({ version: VERSION, runId: "r1", durationMs: 0, outcomes: [merged] });

    expect(summary).not.toContain("noted");
  });
});
