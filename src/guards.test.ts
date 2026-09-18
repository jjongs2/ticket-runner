import { describe, expect, it } from "vitest";
import { skipReason } from "./guards.js";
import type { Issue } from "./ports/tracker.js";

const READY = "ready-for-agent";

/** Comment bodies are what these tests are about; the ids are the port's business. */
type IssueOverrides = Partial<Omit<Issue, "comments">> & { comments?: string[] };

function issue(overrides: IssueOverrides = {}): Issue {
  const { comments, ...rest } = overrides;
  return {
    number: 4,
    title: "Planning guards",
    url: "https://github.com/acme/repo/issues/4",
    body: "- [ ] it works",
    closed: false,
    labels: [READY],
    assignees: [],
    subIssues: 0,
    blockedBy: [],
    ...rest,
    comments: (comments ?? []).map((body, index) => ({ id: String(index), body })),
  };
}

const guard = (overrides: IssueOverrides = {}) => skipReason(issue(overrides), READY, false);

/** The same issue, offered as a Ticket this checkout is already holding. */
const strandedGuard = (overrides: IssueOverrides = {}) =>
  skipReason(issue(overrides), READY, true);

describe("a Ticket Planning got right", () => {
  it("passes every guard", () => {
    expect(guard()).toBeUndefined();
  });
});

describe("issues no Run may take", () => {
  it("refuses one somebody has already claimed", () => {
    expect(guard({ assignees: ["octocat"] })).toBe("claimed");
  });

  it("refuses one that is not labelled ready-for-agent", () => {
    expect(guard({ labels: ["needs-triage"] })).toBe("not-ready");
  });

  it("refuses an untriaged issue before reading it as a Ticket", () => {
    // Nothing the guards would comment on gets said to an issue that was never
    // offered to the pipeline in the first place.
    expect(guard({ labels: [], body: "no criteria here", subIssues: 3 })).toBe("not-ready");
  });
});

describe("a stranded Ticket", () => {
  /** What a Claim leaves on the board: the assignee on, ready-for-agent off. */
  const CLAIMED = { assignees: ["pipeline-user"], labels: ["in-progress"] };

  it("is taken rather than refused for the Claim it is still wearing", () => {
    expect(strandedGuard(CLAIMED)).toBeUndefined();
  });

  it("is still graded by the Planning guards, which are about the issue", () => {
    expect(strandedGuard({ ...CLAIMED, subIssues: 5 })).toBe("spec");
    expect(strandedGuard({ ...CLAIMED, body: "no criteria here" })).toBe("no-criteria");
  });

  it("is refused as usual when nothing says this checkout is holding it", () => {
    expect(guard(CLAIMED)).toBe("claimed");
  });
});

describe("the spec guard", () => {
  it("skips a candidate with native sub-issues", () => {
    expect(guard({ subIssues: 5 })).toBe("spec");
  });

  it("names the Spec before anything else that is wrong with it", () => {
    expect(guard({ subIssues: 5, body: "no criteria here" })).toBe("spec");
  });
});

describe("the criteria guard", () => {
  it("skips a candidate with no checkbox anywhere", () => {
    expect(guard({ body: "## What to build\n\nSomething good." })).toBe("no-criteria");
  });

  it("accepts criteria a triage comment posted instead of the body", () => {
    expect(
      guard({ body: "## What to build\n\nSomething good.", comments: ["- [ ] it works"] }),
    ).toBeUndefined();
  });

  it("accepts an indented or starred checkbox", () => {
    expect(guard({ body: "Criteria:\n  * [ ] it works" })).toBeUndefined();
  });

  it("does not count a checked box as something left to grade", () => {
    expect(guard({ body: "- [x] it worked once" })).toBe("no-criteria");
  });

  it("does not read its own warning comment as criteria", () => {
    // The `no-criteria` warning quotes `- [ ]`, so a naive search for the
    // sequence would find it and pass the issue on the next Run.
    expect(
      guard({
        body: "nothing to grade",
        comments: [
          "<!-- agent-pipeline:guard:no-criteria -->\n**Skipped by agent-pipeline.** No `- [ ]` acceptance criteria found in the body or comments.",
        ],
      }),
    ).toBe("no-criteria");
  });
});

describe("the body-only blockers guard", () => {
  it("skips a candidate whose body names a blocker with no native edge", () => {
    expect(guard({ body: "- [ ] it works\n\n## Blocked by\n\n- #3\n" })).toBe(
      "body-only-blockers",
    );
  });

  it("accepts a body that copies the native edges", () => {
    expect(
      guard({ body: "- [ ] it works\n\n## Blocked by\n\n- #3\n- #7\n", blockedBy: [7, 3] }),
    ).toBeUndefined();
  });

  it("skips a body that names one more blocker than the edges do", () => {
    expect(
      guard({ body: "- [ ] it works\n\n## Blocked by\n\n- #3\n- #7\n", blockedBy: [3] }),
    ).toBe("body-only-blockers");
  });

  it("reads an inline `Blocked by:` line as well as a heading", () => {
    expect(guard({ body: "- [ ] it works\n\nBlocked by: #3, #7\n", blockedBy: [3] })).toBe(
      "body-only-blockers",
    );
  });

  it("never takes a blocker from the body, only from the edges", () => {
    // A native edge to a closed blocker is what unblocks a Ticket; the body
    // copy says the same thing and decides nothing.
    expect(guard({ body: "- [ ] it works\n\n## Blocked by\n\n- #3\n", blockedBy: [3] })).toBeUndefined();
  });

  it("leaves the Parent section alone", () => {
    expect(guard({ body: "## Parent\n\n#1\n\n- [ ] it works\n" })).toBeUndefined();
  });

  it("stops reading at the section after the blockers", () => {
    expect(
      guard({
        body: "## Blocked by\n\n- #3\n\n## Acceptance criteria\n\n- [ ] it closes #9\n",
        blockedBy: [3],
      }),
    ).toBeUndefined();
  });

  it("stops reading at the prose after an inline blockers line", () => {
    expect(
      guard({
        body: "- [ ] it works\n\nBlocked by: #3\n\nThis is the follow-up to #8.\n",
        blockedBy: [3],
      }),
    ).toBeUndefined();
  });

  it("stops at the list that comes after the section, not at the next heading", () => {
    // Acceptance Criteria are a list of checkboxes that quote issue numbers, so
    // reading past the blockers rejects a Ticket Planning got right.
    expect(
      guard({
        body: "## Blocked by\n\n- #3\n\n- [ ] it closes #9\n",
        blockedBy: [3],
      }),
    ).toBeUndefined();
  });

  it("reads an inline `Blocked by:` line and nothing under it", () => {
    expect(
      guard({ body: "Blocked by: #3\n\n- [ ] it closes #9\n", blockedBy: [3] }),
    ).toBeUndefined();
  });

  it("ignores a blocker in another repository, whose numbers do not compare", () => {
    expect(
      guard({ body: "- [ ] it works\n\nBlocked by: acme/other#42\n" }),
    ).toBeUndefined();
  });

  it("accepts a section that names no blocker at all", () => {
    expect(guard({ body: "- [ ] it works\n\n## Blocked by\n\nNothing.\n" })).toBeUndefined();
  });
});
