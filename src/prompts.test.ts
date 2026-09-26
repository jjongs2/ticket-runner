import { describe, expect, it } from "vitest";
import { CONVENTIONS_PATH } from "./conventions.js";
import {
  SELF_HOSTING_GUIDANCE,
  conflictPrompt,
  fixPrompt,
  implementPrompt,
  verifyPrompt,
} from "./prompts.js";

const url = "https://github.com/jjongs2/agent-pipeline/issues/2";

/** The base branch the Run resolved, which most of these prompts only carry. */
const BASE = "main";

const CONFLICT = "CONFLICT (content): Merge conflict in src/cli.ts";

const FAILED_CHECK = {
  kind: "failed-check" as const,
  summary: "Check `npm test` failed",
  evidence: "FAIL src/a.test.ts",
};

/**
 * What both code Stages are told about finishing: a session ends with its turn
 * and stops every background task with it, so work waiting on one is lost.
 */
function expectsForegroundFinish(prompt: string): void {
  expect(prompt).toMatch(
    /never end your turn while uncommitted work waits on a background task/i,
  );
  expect(prompt).toMatch(/run your final tests in the foreground/i);
}

/**
 * What both code Stages are told about leaving the worktree clean.
 * `uncommittedPaths` and `discardChanges` both leave gitignored files alone, so
 * a Stage that deletes the dependencies it installed buys nothing and loses them.
 */
function expectsCleanWorktreeKeepingIgnoredFiles(prompt: string): void {
  expect(prompt).toMatch(/keep gitignored files, such as dependencies you installed/i);
  expect(prompt).toMatch(
    /remove every untracked file that is not ignored and that no commit carries, test output included/i,
  );
}

describe("implementPrompt", () => {
  it("begins with the skill invocation and the full issue URL", () => {
    expect(implementPrompt(url, BASE, "").split("\n")[0]).toBe(
      `/mattpocock-skills:implement ${url}`,
    );
  });

  it("carries the correction guidance for a known plugin defect", () => {
    const prompt = implementPrompt(url, BASE, "");

    expect(prompt).toMatch(/confirm the ticket title/i);
    expect(prompt).toMatch(/commit .*before .*code-review/i);
    expect(prompt).toMatch(/first commit's subject becomes the pull request title/i);
    expect(prompt).toMatch(/summarise the whole Ticket/i);
    expect(prompt).toMatch(/nested review agents|additional review agents/i);
    expect(prompt).toMatch(/do not open pull requests/i);
    expect(prompt).toMatch(/do not close/i);
  });

  it("names the conventions document rather than \"the repo's commit convention\"", () => {
    const prompt = implementPrompt(url, BASE, "");

    expect(prompt).toContain(CONVENTIONS_PATH);
    expect(prompt).not.toMatch(/the repo's commit convention/);
  });

  // A bare `/code-review` also matches the CLI's own built-in skill.
  it("names the review skill by its plugin wherever it refers to it", () => {
    const mentions = implementPrompt(url, BASE, "").match(/\S*code-review\S*/g) ?? [];

    expect(mentions.length).toBeGreaterThan(0);
    for (const mention of mentions) {
      expect(mention).toMatch(/^`?\/mattpocock-skills:code-review\b/);
    }
  });

  it("asks for review sub-agents in the foreground, since omitting the flag backgrounds them", () => {
    const prompt = implementPrompt(url, BASE, "");

    expect(prompt).toContain("`run_in_background: false`");
    expect(prompt).toMatch(/omitt\w* .*run_in_background.* in the background/i);
  });

  it("holds the answer until the review has returned and its fixes are committed", () => {
    const prompt = implementPrompt(url, BASE, "");

    expect(prompt).toMatch(/do not answer .*until .*review has returned/i);
    expect(prompt).toMatch(/fixes .*committed/i);
    expect(prompt).toMatch(/answer you have already given does not stop you committing/i);
  });

  it("says a later answer replaces an earlier one and must repeat the Notes it keeps", () => {
    const prompt = implementPrompt(url, BASE, "");

    expect(prompt).toMatch(/later answer replaces an earlier one/i);
    expect(prompt).toMatch(/repeat every Note/i);
  });

  it("keeps uncommitted work off a background task and the final tests in the foreground", () => {
    expectsForegroundFinish(implementPrompt(url, BASE, ""));
  });

  it("leaves the worktree clean but keeps the gitignored files it installed", () => {
    expectsCleanWorktreeKeepingIgnoredFiles(implementPrompt(url, BASE, ""));
  });

  it("appends the configured extra prompt after the guidance", () => {
    const prompt = implementPrompt(url, BASE, "Prefer table-driven tests.");

    expect(prompt.trimEnd().endsWith("Prefer table-driven tests.")).toBe(true);
  });

  it("leaves no trailing blank block when no extra prompt is configured", () => {
    expect(implementPrompt(url, BASE, "")).toBe(implementPrompt(url, BASE, "   "));
  });
});

describe("verifyPrompt", () => {
  it("does not invoke the implement skill", () => {
    expect(verifyPrompt(url, "")).not.toContain("/mattpocock-skills:implement");
  });

  it("names the Ticket and tells the session to falsify each criterion", () => {
    const prompt = verifyPrompt(url, "");

    expect(prompt).toContain(url);
    expect(prompt).toMatch(/acceptance criteria/i);
    expect(prompt).toMatch(/body and .*comments/i);
    expect(prompt).toMatch(/falsify|disprove|prove .* not met/i);
    expect(prompt).toMatch(/never commit|do not commit/i);
    expect(prompt).toMatch(/verdict/i);
  });

  it("appends the configured extra prompt", () => {
    expect(verifyPrompt(url, "Ignore formatting.").trimEnd().endsWith("Ignore formatting.")).toBe(
      true,
    );
  });
});

describe("fixPrompt", () => {
  it("invokes no plugin skill: the failure is the whole brief", () => {
    expect(fixPrompt(url, FAILED_CHECK, BASE, "")).not.toContain("/mattpocock-skills:");
  });

  it("names the Ticket, the failure and the evidence that was captured", () => {
    const prompt = fixPrompt(url, FAILED_CHECK, BASE, "");

    expect(prompt).toContain(url);
    expect(prompt).toContain("Check `npm test` failed");
    expect(prompt).toContain("FAIL src/a.test.ts");
  });

  it("says which kind of failure this is", () => {
    expect(fixPrompt(url, FAILED_CHECK, BASE, "")).toMatch(/a Check .*failed/i);
    expect(fixPrompt(url, { ...FAILED_CHECK, kind: "unmet-criteria" }, BASE, "")).toMatch(
      /unmet Acceptance Criteria/i,
    );
    expect(fixPrompt(url, { ...FAILED_CHECK, kind: "failed-ci" }, BASE, "")).toMatch(
      /pull request check failed/i,
    );
    expect(
      fixPrompt(url, { ...FAILED_CHECK, kind: "unresolved-conflict" }, BASE, ""),
    ).toMatch(/conflicts with main/i);
    expect(fixPrompt(url, { ...FAILED_CHECK, kind: "uncommitted-work" }, BASE, "")).toMatch(
      /the Stage before you left changes .*never committed/i,
    );
  });

  it("asks for what belongs to the Ticket committed and the rest discarded", () => {
    const prompt = fixPrompt(
      url,
      {
        kind: "uncommitted-work",
        summary: "the implement Stage left changes it never committed",
        evidence: "src/cli.ts",
      },
      BASE,
      "",
    );

    expect(prompt).toMatch(/commit what belongs to this Ticket and discard the rest/i);
    expect(prompt).toContain("src/cli.ts");
  });

  it("keeps uncommitted work off a background task and the final tests in the foreground", () => {
    expectsForegroundFinish(fixPrompt(url, FAILED_CHECK, BASE, ""));
  });

  it("leaves the worktree clean but keeps the gitignored files it installed", () => {
    expectsCleanWorktreeKeepingIgnoredFiles(fixPrompt(url, FAILED_CHECK, BASE, ""));
  });

  it("names the conventions document rather than \"the repo's commit convention\"", () => {
    const prompt = fixPrompt(url, FAILED_CHECK, BASE, "");

    expect(prompt).toContain(CONVENTIONS_PATH);
    expect(prompt).not.toMatch(/the repo's commit convention/);
  });

  it("asks for the regression test a gap the Verdict found should have had", () => {
    expect(fixPrompt(url, { ...FAILED_CHECK, kind: "unmet-criteria" }, BASE, "")).toMatch(
      /regression test/i,
    );
  });

  it("tells the session to commit where it is and to open nothing", () => {
    const prompt = fixPrompt(url, FAILED_CHECK, BASE, "");

    expect(prompt).toMatch(/commit .*on the .*branch|branch you are on/i);
    expect(prompt).toMatch(/do not open pull requests/i);
  });

  it("appends the configured extra prompt", () => {
    const prompt = fixPrompt(url, FAILED_CHECK, BASE, "Keep it small.");

    expect(prompt.trimEnd().endsWith("Keep it small.")).toBe(true);
  });
});

describe("conflictPrompt", () => {
  it("begins with the skill that resolves an in-progress rebase", () => {
    expect(conflictPrompt(url, CONFLICT, BASE, "").split("\n")[0]).toBe(
      "/mattpocock-skills:resolving-merge-conflicts",
    );
  });

  it("names the Ticket and fences what git printed when the rebase stopped", () => {
    const prompt = conflictPrompt(url, CONFLICT, BASE, "");

    expect(prompt).toContain(url);
    expect(prompt).toContain(`\`\`\`\n${CONFLICT}\n\`\`\``);
  });

  it("forbids the two ways out that leave the branch unrebased", () => {
    const prompt = conflictPrompt(url, CONFLICT, BASE, "");

    expect(prompt).toMatch(/never .*rebase --abort/i);
    expect(prompt).toMatch(/rewind the branch/i);
  });

  it("keeps the session inside the conflict, and out of the pipeline's work", () => {
    const prompt = conflictPrompt(url, CONFLICT, BASE, "");

    expect(prompt).toMatch(/implement nothing new/i);
    expect(prompt).toMatch(/no conflict marker/i);
    expect(prompt).toMatch(/do not push/i);
    expect(prompt).toMatch(/do not open pull requests/i);
  });

  it("appends the configured extra prompt", () => {
    expect(
      conflictPrompt(url, CONFLICT, BASE, "Keep it small.").trimEnd().endsWith("Keep it small."),
    ).toBe(true);
  });
});

describe("the self-hosting guidance", () => {
  it("tells the session to exercise the pipeline through its tests and fakes only", () => {
    expect(SELF_HOSTING_GUIDANCE).toMatch(/tests? and fakes/i);
    expect(SELF_HOSTING_GUIDANCE).toMatch(/never run .*against this repository/is);
    expect(SELF_HOSTING_GUIDANCE).toMatch(/never kill .*process/is);
  });

  it("is carried verbatim by every Stage prompt, from one place", () => {
    expect(implementPrompt(url, BASE, "")).toContain(SELF_HOSTING_GUIDANCE);
    expect(verifyPrompt(url, "")).toContain(SELF_HOSTING_GUIDANCE);
    expect(fixPrompt(url, FAILED_CHECK, BASE, "")).toContain(SELF_HOSTING_GUIDANCE);
    expect(conflictPrompt(url, CONFLICT, BASE, "")).toContain(SELF_HOSTING_GUIDANCE);
  });

  it("stays ahead of the repo's own extra prompt", () => {
    const prompt = implementPrompt(url, BASE, "Prefer table-driven tests.");

    expect(prompt.indexOf(SELF_HOSTING_GUIDANCE)).toBeLessThan(
      prompt.indexOf("Prefer table-driven tests."),
    );
  });
});

describe("the Notes channel", () => {
  it("tells the implement Stage where a finding for another Ticket goes", () => {
    const prompt = implementPrompt(url, BASE, "");

    expect(prompt).toContain("Notes for other Tickets");
    expect(prompt).toContain("`notes`");
  });

  it("tells the fix Stage the same", () => {
    expect(fixPrompt(url, FAILED_CHECK, BASE, "")).toContain("Notes for other Tickets");
  });

  it("tells every Stage with the channel that a Note is a defect", () => {
    for (const prompt of [
      implementPrompt(url, BASE, ""),
      fixPrompt(url, FAILED_CHECK, BASE, ""),
      verifyPrompt(url, ""),
    ]) {
      expect(prompt).toContain("A Note is a defect");
      expect(prompt).toContain("are not Notes");
    }
  });

  it("holds a verify Note to the evidence bar a criterion is held to", () => {
    const prompt = verifyPrompt(url, "");

    expect(prompt).toMatch(/carries the evidence that the defect is real in its `evidence` field/i);
    expect(prompt).toContain("something you suspect but did not demonstrate is not a Note");
  });

  it("tells a Stage to leave the number out rather than guess it", () => {
    expect(implementPrompt(url, BASE, "")).toContain("leave it out when you are not sure");
  });

  it("asks every Stage with the channel for a Note in its parts, not as one string", () => {
    for (const prompt of [
      implementPrompt(url, BASE, ""),
      fixPrompt(url, FAILED_CHECK, BASE, ""),
      verifyPrompt(url, ""),
    ]) {
      expect(prompt).toContain("`summary` is one short sentence naming the defect");
      expect(prompt).toContain("`evidence` is where the defect is and what shows it is real");
      expect(prompt).toContain("`impact` is what breaks, and for whom");
      expect(prompt).toContain("`next` is the fix, or the decision a human has to take");
      expect(prompt).not.toContain("`note`");
    }
  });

  it("promises a Stage nothing about issue titles", () => {
    expect(implementPrompt(url, BASE, "")).not.toContain("issue's title");
    expect(fixPrompt(url, FAILED_CHECK, BASE, "")).not.toContain("issue's title");
    expect(implementPrompt(url, BASE, "", 42)).not.toContain("issue's title");
  });

  it("tells a Stage that finding nothing is the ordinary case", () => {
    expect(implementPrompt(url, BASE, "")).toContain(`"notes": []`);
  });

  it("names the standing Notes issue when one is open", () => {
    const prompt = implementPrompt(url, BASE, "", 42);

    expect(prompt).toContain("gathered on #42");
    expect(fixPrompt(url, FAILED_CHECK, BASE, "", 42)).toContain("gathered on #42");
  });

  it("says nothing about one when none is open", () => {
    expect(implementPrompt(url, BASE, "")).not.toContain("gathered on");
    expect(fixPrompt(url, FAILED_CHECK, BASE, "")).not.toContain("gathered on");
  });

  it("asks for what the standing issue does not record, not for another instance of it", () => {
    const prompt = implementPrompt(url, BASE, "", 42);

    expect(prompt).toContain("take what it already records as recorded");
    expect(prompt).toContain("changes what a reader would do about it");
    expect(prompt).toContain("not when it is another instance of the same thing");
  });

  it("passes the number alone, so the prompt does not grow with the backlog", () => {
    const withStanding = implementPrompt(url, BASE, "", 42);
    const without = implementPrompt(url, BASE, "");

    expect(withStanding.length - without.length).toBeLessThan(300);
  });

  it("tells the verify Stage the same, in its own words", () => {
    const prompt = verifyPrompt(url, "");

    expect(prompt).toContain("Notes for other Tickets");
    expect(prompt).toContain("`notes`");
    expect(prompt).toContain("leave it out when you are not sure");
    expect(prompt).toContain("one short sentence");
    expect(prompt).toContain(`"notes": []`);
  });

  it("sends the verify Stage's judgement of a criterion to the Verdict, never to a Note", () => {
    const prompt = verifyPrompt(url, "");

    expect(prompt).toMatch(/criterion belongs in the Verdict/i);
    expect(prompt).toMatch(/never in a Note/i);
  });

  it("leaves the verify Stage fixing, committing and staging nothing", () => {
    expect(verifyPrompt(url, "")).toMatch(/fix nothing, commit nothing/i);
  });

  it("names the standing Notes issue to the verify Stage when one is open", () => {
    expect(verifyPrompt(url, "", 42)).toContain("gathered on #42");
    expect(verifyPrompt(url, "")).not.toContain("gathered on");
  });

  it("asks the Stage that only rebases for no Notes", () => {
    expect(conflictPrompt(url, CONFLICT, BASE, "")).not.toContain("Notes for other Tickets");
  });
});

describe("the resolved base branch", () => {
  it("is what the implement Stage is told its subject lands on", () => {
    const prompt = implementPrompt(url, "release", "");

    expect(prompt).toContain("the squash commit on `release`");
    expect(prompt).not.toContain("`main`");
  });

  it("is what the conflict Stage is told the rebase stopped against", () => {
    const prompt = conflictPrompt(url, CONFLICT, "release", "");

    expect(prompt).toContain("rebasing it onto `release`");
    expect(prompt).toContain("keep `release`'s everywhere the Ticket is silent");
    expect(prompt).not.toContain("`main`");
  });

  it("is what the fix Stage is told a branch that will not replay conflicts with", () => {
    const prompt = fixPrompt(
      url,
      { ...FAILED_CHECK, kind: "unresolved-conflict" },
      "release",
      "",
    );

    expect(prompt).toContain("the branch conflicts with release");
    expect(prompt).not.toContain("conflicts with main");
  });
});
