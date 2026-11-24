import { describe, expect, it } from "vitest";
import { listCriteria } from "./acceptance-criteria.js";
import { CONVENTIONS_PATH } from "./conventions.js";
import {
  SELF_HOSTING_GUIDANCE,
  STAGE_BOUNDARY_GUIDANCE,
  conflictPrompt,
  fixPrompt,
  implementPrompt,
  verifyPrompt,
} from "./prompts.js";
import { SUBJECT_SHAPE } from "./title.js";

const url = "https://github.com/jjongs2/ticket-runner/issues/2";

/** The base branch the Run resolved, which most of these prompts only carry. */
const BASE = "main";

/** Whether the Target is the pipeline's own repository, as the prompts are told. */
const OTHER_TARGET = false;
const SELF_HOSTED = true;

/** A Target whose config names no Check commands, and one whose does. */
const NO_CHECKS: string[] = [];
const CHECKS = ["npm test", "npm run typecheck"];

const CONFLICT = "CONFLICT (content): Merge conflict in src/cli.ts";

const FAILED_CI = {
  kind: "failed-ci" as const,
  summary: "test (ubuntu-latest) failed",
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
  expect(prompt).not.toMatch(/run your final tests in the foreground, then commit/i);
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
    expect(implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS).split("\n")[0]).toBe(
      `/mattpocock-skills:implement ${url}`,
    );
  });

  it("carries the correction guidance for a known plugin defect", () => {
    const prompt = implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toMatch(/commit .*before .*code-review/i);
    expect(prompt).toMatch(/nested review agents|additional review agents/i);
    expect(prompt).toMatch(/do not open pull requests/i);
    expect(prompt).toMatch(/do not close/i);
  });

  it("asks for a branch slug in its shape, in English whatever language the other answers take", () => {
    const prompt = implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS);
    const line = prompt.split("\n").find((l) => l.includes("`branch`"));

    expect(line).toBeDefined();
    expect(line).toContain("`agent/<n>-<slug>`");
    expect(line).toContain("at most 40 characters matching `^[a-z0-9]+(-[a-z0-9]+)*$`");
    expect(line).toContain("in English words saying what the Ticket does");
    expect(line).toContain("whatever language your other answers take");
    // The language rule lists what follows the Target's language, and the slug is not among them.
    const language = prompt.split("\n").find((l) => l.includes("in the language this repository's"));
    expect(language).not.toContain("`branch`");
  });

  it("tells the Stage not to push, since the branch is renamed before its first push", () => {
    const prompt = implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toMatch(/^- Do not push, do not open pull requests and do not close the issue/m);
  });

  it("states the subject shape itself rather than pointing at the conventions document", () => {
    const prompt = implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toContain(`\`${SUBJECT_SHAPE}\``);
    expect(prompt).not.toContain(CONVENTIONS_PATH);
    expect(prompt).not.toMatch(/the repo's commit convention/);
  });

  // A bare `/code-review` also matches the CLI's own built-in skill.
  it("names the review skill by its plugin wherever it refers to it", () => {
    const mentions = implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS).match(/\S*code-review\S*/g) ?? [];

    expect(mentions.length).toBeGreaterThan(0);
    for (const mention of mentions) {
      expect(mention).toMatch(/^`?\/mattpocock-skills:code-review\b/);
    }
  });

  // The review otherwise looks for its spec in the commit messages, which need
  // not name the Ticket, and reviews with none without saying so.
  it("tells the review the Ticket's URL is its spec", () => {
    const prompt = implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS);
    const line = prompt.split("\n").find((l) => l.includes(`\`${url}\``) && /as the spec/.test(l));

    expect(line).toBeDefined();
    expect(line).toMatch(/pass the review/i);
  });

  it("asks for review sub-agents in the foreground, since omitting the flag backgrounds them", () => {
    const prompt = implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toContain("`run_in_background: false`");
    expect(prompt).toMatch(/omitt\w* .*run_in_background.* in the background/i);
  });

  it("holds the answer until the review has returned and its fixes are committed", () => {
    const prompt = implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toMatch(/do not answer .*until .*review has returned/i);
    expect(prompt).toMatch(/fixes .*committed/i);
    expect(prompt).toMatch(/answer you have already given does not stop you committing/i);
  });

  it("says a later answer replaces an earlier one and must repeat the Notes it keeps", () => {
    const prompt = implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toMatch(/later answer replaces an earlier one/i);
    expect(prompt).toMatch(/repeat every Note/i);
  });

  it("keeps uncommitted work off a background task", () => {
    expectsForegroundFinish(implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS));
    expectsForegroundFinish(implementPrompt(url, BASE, "", OTHER_TARGET, CHECKS));
  });

  it("no longer asks the Stage to confirm the Ticket title", () => {
    expect(implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS)).not.toMatch(
      /confirm the Ticket title/i,
    );
  });

  it("leaves the worktree clean but keeps the gitignored files it installed", () => {
    expectsCleanWorktreeKeepingIgnoredFiles(implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS));
  });

  it("appends the configured extra prompt after the guidance", () => {
    const prompt = implementPrompt(url, BASE, "Prefer table-driven tests.", OTHER_TARGET, NO_CHECKS);

    expect(prompt.trimEnd().endsWith("Prefer table-driven tests.")).toBe(true);
  });

  it("leaves no trailing blank block when no extra prompt is configured", () => {
    expect(implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS)).toBe(implementPrompt(url, BASE, "   ", OTHER_TARGET, NO_CHECKS));
  });
});

describe("verifyPrompt", () => {
  it("does not invoke the implement skill", () => {
    expect(verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS)).not.toContain("/mattpocock-skills:implement");
  });

  it("names the Ticket and tells the session to falsify each criterion", () => {
    const prompt = verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toContain(url);
    expect(prompt).toMatch(/acceptance criteria/i);
    expect(prompt).toMatch(/falsify|disprove|prove .* not met/i);
    expect(prompt).toMatch(/never commit|do not commit/i);
    expect(prompt).toMatch(/verdict/i);
  });

  it("appends the configured extra prompt", () => {
    expect(verifyPrompt(url, "Ignore formatting.", OTHER_TARGET, NO_CHECKS).trimEnd().endsWith("Ignore formatting.")).toBe(
      true,
    );
  });
});

describe("fixPrompt", () => {
  it("asks for no branch slug: only the implement Stage names the branch", () => {
    const prompt = fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).not.toContain("`branch`");
    expect(prompt).not.toContain("<slug>");
  });

  it("invokes no plugin skill but the pr skill: the implement skill would start over", () => {
    const prompt = fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS);
    const skills = prompt.match(/\/mattpocock-skills:[a-z-]+/g) ?? [];

    expect(new Set(skills)).toEqual(new Set(["/mattpocock-skills:pr"]));
    expect(prompt).toMatch(/Invoke no plugin skill but `\/mattpocock-skills:pr`/);
    expect(prompt).not.toContain("/mattpocock-skills:implement");
  });

  it("names the Ticket, the failure and the evidence that was captured", () => {
    const prompt = fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toContain(url);
    expect(prompt).toContain("test (ubuntu-latest) failed");
    expect(prompt).toContain("FAIL src/a.test.ts");
  });

  it("says which kind of failure this is", () => {
    expect(fixPrompt(url, { ...FAILED_CI, kind: "unmet-criteria" }, BASE, "", OTHER_TARGET, NO_CHECKS)).toMatch(
      /unmet Acceptance Criteria/i,
    );
    expect(fixPrompt(url, { ...FAILED_CI, kind: "failed-ci" }, BASE, "", OTHER_TARGET, NO_CHECKS)).toMatch(
      /pull request check failed/i,
    );
    expect(
      fixPrompt(url, { ...FAILED_CI, kind: "unresolved-conflict" }, BASE, "", OTHER_TARGET, NO_CHECKS),
    ).toMatch(/conflicts with main/i);
    expect(fixPrompt(url, { ...FAILED_CI, kind: "uncommitted-work" }, BASE, "", OTHER_TARGET, NO_CHECKS)).toMatch(
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
      OTHER_TARGET,
      NO_CHECKS,
    );

    expect(prompt).toMatch(/commit what belongs to this Ticket and discard the rest/i);
    expect(prompt).toContain("src/cli.ts");
  });

  it("keeps uncommitted work off a background task", () => {
    expectsForegroundFinish(fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS));
    expectsForegroundFinish(fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, CHECKS));
  });

  it("leaves the worktree clean but keeps the gitignored files it installed", () => {
    expectsCleanWorktreeKeepingIgnoredFiles(fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS));
  });

  it("states the subject shape itself, for its commits and its title alike", () => {
    const prompt = fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS);
    const lines = prompt.split("\n");
    const commits = lines.find((line) => line.startsWith("- Write commit subjects"));
    const title = lines.find((line) => /answer a `title`/i.test(line));

    expect(commits).toContain(`\`${SUBJECT_SHAPE}\``);
    expect(title).toContain(`\`${SUBJECT_SHAPE}\``);
    expect(prompt).not.toContain(CONVENTIONS_PATH);
    expect(prompt).not.toMatch(/the repo's commit convention/);
  });

  it("asks for the regression test a gap the verdict found should have had", () => {
    expect(fixPrompt(url, { ...FAILED_CI, kind: "unmet-criteria" }, BASE, "", OTHER_TARGET, NO_CHECKS)).toMatch(
      /regression test/i,
    );
  });

  it("tells the session to commit where it is and to open nothing", () => {
    const prompt = fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toMatch(/commit .*on the .*branch|branch you are on/i);
    expect(prompt).toMatch(/do not open pull requests/i);
  });

  it("appends the configured extra prompt", () => {
    const prompt = fixPrompt(url, FAILED_CI, BASE, "Keep it small.", OTHER_TARGET, NO_CHECKS);

    expect(prompt.trimEnd().endsWith("Keep it small.")).toBe(true);
  });
});

describe("conflictPrompt", () => {
  it("invokes no plugin skill and refers to none: the stopped rebase is the whole brief", () => {
    const prompt = conflictPrompt(url, CONFLICT, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).not.toContain("/mattpocock-skills:");
    expect(prompt).not.toMatch(/skill/i);
  });

  it("names the Ticket and fences what git printed when the rebase stopped", () => {
    const prompt = conflictPrompt(url, CONFLICT, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toContain(url);
    expect(prompt).toContain(`\`\`\`\n${CONFLICT}\n\`\`\``);
  });

  it("forbids the two ways out that leave the branch unrebased", () => {
    const prompt = conflictPrompt(url, CONFLICT, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toMatch(/never .*rebase --abort/i);
    expect(prompt).toMatch(/rewind the branch/i);
  });

  it("keeps the session inside the conflict, and out of the pipeline's work", () => {
    const prompt = conflictPrompt(url, CONFLICT, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toMatch(/implement nothing new/i);
    expect(prompt).toMatch(/no conflict marker/i);
    expect(prompt).toMatch(/do not push/i);
    expect(prompt).toMatch(/do not open pull requests/i);
  });

  it("appends the configured extra prompt", () => {
    expect(
      conflictPrompt(url, CONFLICT, BASE, "Keep it small.", OTHER_TARGET, NO_CHECKS).trimEnd().endsWith("Keep it small."),
    ).toBe(true);
  });
});

describe("the Stage boundary guidance", () => {
  /** Every Stage prompt, built for one kind of Target, with `extra` as the config's extra prompt. */
  const everyPrompt = (selfHosted: boolean, extra = "") => [
    implementPrompt(url, BASE, extra, selfHosted, NO_CHECKS),
    verifyPrompt(url, extra, selfHosted, NO_CHECKS),
    fixPrompt(url, FAILED_CI, BASE, extra, selfHosted, NO_CHECKS),
    conflictPrompt(url, CONFLICT, BASE, extra, selfHosted, NO_CHECKS),
  ];

  it("tells the session what holds in every Target", () => {
    expect(STAGE_BOUNDARY_GUIDANCE).toMatch(/never run `ticket-runner` against this repository or GitHub/i);
    expect(STAGE_BOUNDARY_GUIDANCE).toMatch(/never kill processes you did not start/i);
    expect(STAGE_BOUNDARY_GUIDANCE).toMatch(/refusal is expected; do not work around it/i);
    expect(STAGE_BOUNDARY_GUIDANCE).toContain("TICKET_RUNNER_STAGE");
  });

  it("names the pipeline as the command that started the session, not as the checkout", () => {
    expect(STAGE_BOUNDARY_GUIDANCE).toMatch(/started this session/i);
    expect(STAGE_BOUNDARY_GUIDANCE).not.toMatch(/checkout/i);
  });

  it("keeps the checkout, its tests and fakes and its spellings to the self-hosting part", () => {
    expect(STAGE_BOUNDARY_GUIDANCE).not.toMatch(/tests? and fakes/i);
    expect(STAGE_BOUNDARY_GUIDANCE).not.toContain("npm run ticket-runner");
    expect(STAGE_BOUNDARY_GUIDANCE).not.toContain("npx tsx src/cli.ts");

    expect(SELF_HOSTING_GUIDANCE).toMatch(/this checkout is the pipeline that started this session/i);
    expect(SELF_HOSTING_GUIDANCE).toMatch(/only through its tests and fakes/i);
    expect(SELF_HOSTING_GUIDANCE).toContain("`npm run ticket-runner`");
    expect(SELF_HOSTING_GUIDANCE).toContain("`npx tsx src/cli.ts`");
  });

  it("gives a Stage in another Target the every-Target part and nothing of the checkout", () => {
    for (const prompt of everyPrompt(OTHER_TARGET)) {
      expect(prompt).toContain(STAGE_BOUNDARY_GUIDANCE);
      expect(prompt).not.toContain(SELF_HOSTING_GUIDANCE);
      expect(prompt).not.toMatch(/checkout is the pipeline/i);
      expect(prompt).not.toMatch(/tests? and fakes/i);
      expect(prompt).not.toContain("npm run ticket-runner");
      expect(prompt).not.toContain("npx tsx src/cli.ts");
    }
  });

  it("gives a Stage in the pipeline's own repository both parts, verbatim from one place", () => {
    for (const prompt of everyPrompt(SELF_HOSTED)) {
      expect(prompt).toContain(STAGE_BOUNDARY_GUIDANCE);
      expect(prompt).toContain(SELF_HOSTING_GUIDANCE);
    }
  });

  it("stays ahead of the repo's own extra prompt, in both kinds of Target", () => {
    for (const selfHosted of [OTHER_TARGET, SELF_HOSTED]) {
      for (const prompt of everyPrompt(selfHosted, "Prefer table-driven tests.")) {
        const extra = prompt.indexOf("Prefer table-driven tests.");
        expect(prompt.indexOf(STAGE_BOUNDARY_GUIDANCE)).toBeLessThan(extra);
        if (selfHosted) expect(prompt.indexOf(SELF_HOSTING_GUIDANCE)).toBeLessThan(extra);
      }
    }
  });
});

describe("the criteria verify grades", () => {
  const criteria = listCriteria([
    "- [ ] it works\n  - on Linux\n  - on Windows\n  - [ ] it is fast",
    "Brief:\n\n- [ ] it is documented",
  ]);

  it("lists each unticked criterion by number, with the indented lines under its checkbox", () => {
    const prompt = verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS, undefined, undefined, { criteria });

    expect(prompt).toContain("## The Acceptance Criteria, by number");
    expect(prompt).toContain(
      "1. it works\n   - on Linux\n   - on Windows\n2. it is fast\n3. it is documented",
    );
  });

  it("asks for each criterion back by its number, every listed number once", () => {
    const prompt = verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS, undefined, undefined, { criteria });

    expect(prompt).toContain("answer each by its number, every listed number once and no other");
    expect(prompt).not.toMatch(/verbatim/i);
  });

  it("fences a criterion that carries a fence of its own", () => {
    const fenced = listCriteria(["- [ ] it prints:\n\n  ```\n  ok\n  ```"]);

    const prompt = verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS, undefined, undefined, {
      criteria: fenced,
    });

    expect(prompt).toContain("````\n1. it prints:\n\n   ```\n   ok\n   ```\n````");
  });
});

describe("the Notes a verify Stage is shown", () => {
  it("lists what this Ticket's code Stages wrote, part by part", () => {
    const prompt = verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS, undefined, undefined, {
      written: [
        { stage: "implement", note: { summary: "a handle leaks", evidence: "lsof", next: "close it" } },
      ],
    });

    expect(prompt).toContain("## Notes this Ticket's implement and fix Stages wrote in this Run");
    expect(prompt).toContain("- From the implement Stage: a handle leaks\n  evidence: lsof\n  next: close it");
    expect(prompt).toMatch(/defect this branch made is graded in your verdict's `defects`/);
  });
});

describe("the Notes channel", () => {
  it("tells every Stage with the channel that what the Ticket's own deliverable records is not a Note", () => {
    for (const prompt of [
      implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS),
      fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS),
      verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS),
    ]) {
      expect(prompt).toContain("What this Ticket's own deliverable already records is not a Note");
    }
  });

  it("tells the implement Stage where a finding for another Ticket goes", () => {
    const prompt = implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toContain("Notes for other Tickets");
    expect(prompt).toContain("`notes`");
  });

  it("tells the fix Stage the same", () => {
    expect(fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS)).toContain("Notes for other Tickets");
  });

  it("tells every Stage with the channel that a Note is a defect", () => {
    for (const prompt of [
      implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS),
      fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS),
      verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS),
    ]) {
      expect(prompt).toContain("A Note is a defect");
      expect(prompt).toContain("are not Notes");
    }
  });

  it("holds a verify Note to the evidence bar a criterion is held to", () => {
    const prompt = verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toMatch(/carries the evidence that the defect is real in its `evidence` field/i);
    expect(prompt).toContain("something you suspect but did not demonstrate is not a Note");
  });

  it("tells a Stage to leave the number out rather than guess it", () => {
    expect(implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS)).toContain("leave it out when you are not sure");
  });

  it("asks every Stage with the channel for a Note in its parts, not as one string", () => {
    for (const prompt of [
      implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS),
      fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS),
      verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS),
    ]) {
      expect(prompt).toContain("`summary` is one short sentence naming the defect");
      expect(prompt).toContain("`evidence` is where the defect is and what shows it is real");
      expect(prompt).toContain("`impact` is what breaks, and for whom");
      expect(prompt).toContain("`next` is the fix, or the decision a human has to take");
      expect(prompt).not.toContain("`note`");
    }
  });

  it("promises a Stage nothing about issue titles", () => {
    expect(implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS)).not.toContain("issue's title");
    expect(fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS)).not.toContain("issue's title");
    expect(implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS, 42)).not.toContain("issue's title");
  });

  it("tells a Stage that finding nothing is the ordinary case", () => {
    expect(implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS)).toContain(`"notes": []`);
  });

  it("names the standing Notes issue when one is open", () => {
    const prompt = implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS, 42);

    expect(prompt).toContain("gathered on #42");
    expect(fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS, 42)).toContain("gathered on #42");
  });

  it("says nothing about one when none is open", () => {
    expect(implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS)).not.toContain("gathered on");
    expect(fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS)).not.toContain("gathered on");
  });

  it("asks for what the standing issue does not record, not for another instance of it", () => {
    const prompt = implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS, 42);

    expect(prompt).toContain("take what it already records as recorded");
    expect(prompt).toContain("changes what a reader would do about it");
    expect(prompt).toContain("not when it is another instance of the same thing");
  });

  it("passes the number alone, so the prompt does not grow with the backlog", () => {
    const withStanding = implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS, 42);
    const without = implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(withStanding.length - without.length).toBeLessThan(300);
  });

  it("tells the verify Stage the same, in its own words", () => {
    const prompt = verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toContain("Notes for other Tickets");
    expect(prompt).toContain("`notes`");
    expect(prompt).toContain("leave it out when you are not sure");
    expect(prompt).toContain("one short sentence");
    expect(prompt).toContain(`"notes": []`);
  });

  it("sends the verify Stage's judgement of a criterion to the verdict, never to a Note", () => {
    const prompt = verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toMatch(/criterion belongs in the verdict/i);
    expect(prompt).toMatch(/never in a Note/i);
  });

  it("leaves the verify Stage fixing, committing and staging nothing", () => {
    expect(verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS)).toMatch(/fix nothing, commit nothing/i);
  });

  it("names the standing Notes issue to the verify Stage when one is open", () => {
    expect(verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS, 42)).toContain("gathered on #42");
    expect(verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS)).not.toContain("gathered on");
  });

  it("asks the Stage that only rebases for no Notes", () => {
    expect(conflictPrompt(url, CONFLICT, BASE, "", OTHER_TARGET, NO_CHECKS)).not.toContain("Notes for other Tickets");
  });
});

describe("the branch a Stage works on", () => {
  // The pipeline pushes the branch it checked out, and the conventions document
  // leaves this to the prompts, so every Stage that commits hears it here.
  it("is the only one every Stage that commits is told to use", () => {
    const prompts = [
      implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS),
      fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS),
      conflictPrompt(url, CONFLICT, BASE, "", OTHER_TARGET, NO_CHECKS),
    ];

    for (const prompt of prompts) {
      expect(prompt).toMatch(/do not create a branch, and do not switch to another/i);
    }
    expect(prompts[0]).toMatch(/commit all of your work to the branch that is already checked out/i);
  });
});

describe("the conventions document", () => {
  // A Stage hears the rules it acts on from its own prompt; the document is for
  // the readers the pipeline does not brief, and repeats none of them.
  it("is named by no Stage prompt", () => {
    const prompts = [
      implementPrompt(url, BASE, "", SELF_HOSTED, CHECKS),
      verifyPrompt(url, "", SELF_HOSTED, CHECKS),
      fixPrompt(url, FAILED_CI, BASE, "", SELF_HOSTED, CHECKS),
      fixPrompt(url, { ...FAILED_CI, kind: "unmet-criteria" }, BASE, "", SELF_HOSTED, CHECKS),
      conflictPrompt(url, CONFLICT, BASE, "", SELF_HOSTED, CHECKS),
    ];

    for (const prompt of prompts) expect(prompt).not.toContain(CONVENTIONS_PATH);
  });
});

describe("the title of the branch", () => {
  const prompts = () => [
    implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS),
    fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS),
  ];

  it("is what both code Stages are asked to answer, for the whole branch", () => {
    for (const prompt of prompts()) {
      expect(prompt).toMatch(/answer a `title` beside your Notes/i);
      expect(prompt).toContain("summarising the whole branch as it stands when you finish");
      expect(prompt).toContain("`<type>[(<scope>)]: <summary>`");
      expect(prompt).toContain("without the `(#<n>)`");
      expect(prompt).toContain("It titles the pull request and the squash commit on `main`");
    }
  });

  // A fix Stage that never opened the guide put a scope in the title of a
  // Target whose guide forbids one (#334).
  it("is written in the Target's own words within the shape, in both code Stages", () => {
    const rule = `in the \`${SUBJECT_SHAPE}\` shape, using the types, scopes and wording this repository's contributing guide sets for a commit subject or a pull request title, where it sets them`;

    for (const prompt of prompts()) {
      const title = prompt.split("\n").find((line) => /answer a `title` beside your Notes/i.test(line));
      expect(title).toContain(rule);
    }
    const commits = fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS)
      .split("\n")
      .find((line) => line.startsWith("- Write commit subjects"));
    expect(commits).toContain(rule);
  });

  it("is kept by a fix Stage whose fix leaves it true, and answered by the implement Stage", () => {
    const fix = fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(fix).toContain(
      "Answer `title` as an empty string, which keeps it, unless your fix changes what it says.",
    );
    expect(implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS)).not.toMatch(
      /`title` as an empty string/,
    );
  });

  it("is no longer read off the first commit", () => {
    for (const prompt of prompts()) {
      expect(prompt).not.toMatch(/first commit/i);
      expect(prompt).not.toMatch(/subject becomes the pull request title/i);
    }
  });

  it("is asked of neither the verify nor the conflict Stage", () => {
    expect(verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS)).not.toContain("`title`");
    expect(conflictPrompt(url, CONFLICT, BASE, "", OTHER_TARGET, NO_CHECKS)).not.toContain("`title`");
  });
});

describe("the resolved base branch", () => {
  it("is what the implement Stage is told its subject lands on", () => {
    const prompt = implementPrompt(url, "release", "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toContain("the squash commit on `release`");
    expect(prompt).not.toContain("`main`");
  });

  it("is what the fix Stage is told its title lands on", () => {
    const prompt = fixPrompt(url, FAILED_CI, "release", "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toContain("the squash commit on `release`");
    expect(prompt).not.toContain("`main`");
  });

  it("is what the conflict Stage is told the rebase stopped against", () => {
    const prompt = conflictPrompt(url, CONFLICT, "release", "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toContain("rebasing it onto `release`");
    expect(prompt).toContain("keep `release`'s everywhere the Ticket is silent");
    expect(prompt).not.toContain("`main`");
  });

  it("is what the fix Stage is told a branch that will not replay conflicts with", () => {
    const prompt = fixPrompt(
      url,
      { ...FAILED_CI, kind: "unresolved-conflict" },
      "release",
      "",
      OTHER_TARGET,
      NO_CHECKS,
    );

    expect(prompt).toContain("the branch conflicts with release");
    expect(prompt).not.toContain("conflicts with main");
  });
});

describe("the Checks, which the pipeline runs on no branch", () => {
  const UNMET = {
    kind: "unmet-criteria" as const,
    summary: "1 of 1 criteria unmet",
    evidence: "- it works — npm test is red",
  };
  /** Every Stage prompt, built for a Target with `checks` configured. */
  const everyPrompt = (checks: string[]) => [
    implementPrompt(url, BASE, "", OTHER_TARGET, checks),
    verifyPrompt(url, "", OTHER_TARGET, checks),
    fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, checks),
    conflictPrompt(url, CONFLICT, BASE, "", OTHER_TARGET, checks),
  ];

  it("are named to every Stage where the config has them", () => {
    for (const prompt of everyPrompt(CHECKS)) {
      expect(prompt).toContain("`npm test`, `npm run typecheck`");
    }
  });

  it("are named to no Stage where it has none", () => {
    for (const prompt of everyPrompt(NO_CHECKS)) {
      expect(prompt).not.toMatch(/Checks are|does not run its Checks|run the full Checks/i);
    }
  });

  /**
   * The pipeline runs none of them, so no prompt may say it does, that a
   * failure of them spends the fix budget, or that CI runs them: what CI runs
   * is the Target's to set up, and nothing here knows it.
   */
  it("are said by no code or conflict Stage prompt to be run by the pipeline or CI, or to cost the fix budget", () => {
    for (const prompt of [
      implementPrompt(url, BASE, "", OTHER_TARGET, CHECKS),
      fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, CHECKS),
      fixPrompt(url, UNMET, BASE, "", OTHER_TARGET, CHECKS),
      conflictPrompt(url, CONFLICT, BASE, "", OTHER_TARGET, CHECKS),
    ]) {
      expect(prompt).not.toMatch(/pipeline (re-)?runs (its|the) Checks/i);
      expect(prompt).not.toMatch(/Checks[^.\n]*fix budget|fix budget[^.\n]*Checks/i);
      expect(prompt).not.toMatch(/CI runs (them|the Checks)|Checks[^.\n]*\bCI\b/i);
    }
  });

  it("are run once by both code Stages, after committing", () => {
    for (const prompt of [
      implementPrompt(url, BASE, "", OTHER_TARGET, CHECKS),
      fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, CHECKS),
    ]) {
      expect(prompt).toMatch(/while you work, run only the tests your change touches/i);
      expect(prompt).toMatch(/commit, then run the full Checks once, in the foreground/i);
      expect(prompt).toMatch(/commit whatever that run makes you change/i);
    }
  });

  it("run once in implement only after the review's fixes are committed", () => {
    expect(implementPrompt(url, BASE, "", OTHER_TARGET, CHECKS)).toMatch(
      /that one run comes after the review's fixes are committed/i,
    );
    expect(fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, CHECKS)).not.toMatch(
      /review's fixes/i,
    );
  });

  it("are not run by verify to grade the branch, which it is told nobody has done since the Stage before it", () => {
    const prompt = verifyPrompt(url, "", OTHER_TARGET, CHECKS);

    expect(prompt).toContain(
      "The pipeline does not run its Checks (`npm test`, `npm run typecheck`), and the Stage before you was told to run them once. Do not run them to grade the branch: spend your turns on targeted tests and probes.",
    );
    expect(prompt).not.toMatch(/passed on this commit/i);
  });

  it("are not mentioned to verify where none are configured", () => {
    expect(verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS)).not.toContain(
      "The pipeline does not run its Checks",
    );
  });

  it("leave verify to answer `ci` for a criterion asking for nothing but CI, or commands, to pass, whatever is configured", () => {
    for (const checks of [CHECKS, NO_CHECKS]) {
      expect(verifyPrompt(url, "", OTHER_TARGET, checks)).toContain(
        "For a criterion that asks for nothing but the pull request's CI, or some commands, to pass: if a workflow under `.github/workflows/` runs on this pull request, its triggers and `paths` filters admitting the branch's changes, and runs every command the criterion names, whole or split across jobs, answer `ci`, with evidence naming the workflow and its steps; the pipeline ticks it once CI passes. Otherwise grade the criterion yourself, running the commands it names.",
      );
    }
  });

  it("are narrowed by the conflict Stage to the type checker and the tests of what it resolved", () => {
    const prompt = conflictPrompt(url, CONFLICT, BASE, "", OTHER_TARGET, CHECKS);

    expect(prompt).toMatch(
      /run the type checker and the tests covering the files you resolved, not the whole suite/i,
    );
  });

  it("are named to a fix Stage sent in for unmet criteria too", () => {
    expect(fixPrompt(url, UNMET, BASE, "", OTHER_TARGET, CHECKS)).toContain(
      "`npm test`, `npm run typecheck`",
    );
  });
});

describe("a defect the branch introduced", () => {
  it("is the code Stages' to fix, never a Note", () => {
    for (const prompt of [
      implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS),
      fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS),
    ]) {
      expect(prompt).toMatch(/a defect this branch introduced\b.* belongs to this Ticket/i);
      expect(prompt).toContain("behaves correctly on the base branch and wrongly here");
      expect(prompt).toMatch(/one in code this branch added/i);
      expect(prompt).toMatch(/fix it, and do not record it as a Note/i);
    }
  });

  it("is reported in verify's verdict beside the criteria, not as a Note, unless the Ticket or a decision accepts it", () => {
    const prompt = verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toContain(
      "A defect this branch introduced, one that behaves correctly on the base branch and wrongly here, or one in code this branch added, is reported in the verdict's `defects`, beside the criteria and not as a Note, when you show it with the evidence an `unmet` criterion needs, unless the Ticket leaves it out of scope or a documented decision accepts it.",
    );
    expect(prompt).toMatch(/fails the verdict as an `unmet` criterion does/);
  });

  it("no longer leaves verify grading the Acceptance Criteria and nothing else", () => {
    expect(verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS)).not.toMatch(/and nothing else/i);
  });

  it("reaches a fix Stage sent in for it, which commits nothing for one only a human can settle", () => {
    const prompt = fixPrompt(
      url,
      { kind: "unmet-criteria", summary: "the branch made 1 defect", evidence: "- Defect: it crashes — ran it" },
      BASE,
      "",
      OTHER_TARGET,
      NO_CHECKS,
    );

    expect(prompt).toContain("unmet Acceptance Criteria, or defects this branch made");
    expect(prompt).toMatch(/or any defect cannot be fixed without overturning one.*commit nothing/);
  });
});

describe("a code Stage that ends without a new commit", () => {
  const KINDS = [
    "failed-check",
    "unmet-criteria",
    "failed-ci",
    "unresolved-conflict",
    "uncommitted-work",
  ] as const;

  it.each(KINDS)("is told by the fix prompt, sent in for %s, to say why in `noCommitReason`", (kind) => {
    const prompt = fixPrompt(url, { ...FAILED_CI, kind }, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toMatch(/if you end without a new commit, say why in `noCommitReason`/i);
    expect(prompt).not.toMatch(/last message/i);
  });

  it("is not invited by the implement prompt to end that way: the schema alone asks it", () => {
    const prompt = implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS);
    const mentions = prompt.split("\n").filter((line) => line.includes("noCommitReason"));

    // Named only in the list of answers written in the Target's language.
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatch(/^- Write your Notes, .* in the language/);
    expect(prompt).not.toMatch(/without a new commit/i);
  });
});

describe("a criterion that needs a human decision", () => {
  const UNMET = {
    kind: "unmet-criteria" as const,
    summary: "1 of 1 criteria unmet",
    evidence: "- it works — npm test is red",
  };

  it("is unmet to verify, with evidence saying a human decision is needed", () => {
    const prompt = verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toMatch(
      /cannot be met without overturning a documented decision or another criterion, mark it `unmet`/i,
    );
    expect(prompt).toMatch(/say in its evidence that a human decision is needed/i);
  });

  it("makes the fix Stage commit nothing and say why in `noCommitReason`", () => {
    const prompt = fixPrompt(url, UNMET, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toMatch(
      /any unmet criterion cannot be met without overturning a documented decision or another criterion/i,
    );
    expect(prompt).toMatch(/commit nothing and give your reason in `noCommitReason`/i);
    expect(prompt).not.toMatch(/last message/i);
  });

  it("is not raised with a fix Stage sent in for anything but unmet criteria", () => {
    expect(fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS)).not.toMatch(
      /overturning a documented decision/i,
    );
  });
});

describe("an unmet criterion's evidence", () => {
  const UNMET = {
    kind: "unmet-criteria" as const,
    summary: "1 of 1 criteria unmet",
    evidence: "- it works — npm test is red",
  };
  const OTHER_KINDS = [
    "failed-check",
    "failed-ci",
    "unresolved-conflict",
    "uncommitted-work",
  ] as const;

  /** The fix Stage's section that carries the unmet criteria, heading to fenced evidence. */
  function failureSectionOf(prompt: string): string {
    const start = prompt.indexOf("## The failure:");
    const end = prompt.indexOf(`\`\`\`\n${UNMET.evidence}`, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return prompt.slice(start, end);
  }

  it("states the failure to verify: where, what was run or read, expected, got, the counterexample", () => {
    const prompt = verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toMatch(
      /an `unmet` criterion's evidence states the failure: where it sits, what you ran or read, what you expected, what came back, and the counterexample/i,
    );
  });

  it("proposes no fix and no direction for one, a human decision's judgement included", () => {
    const prompt = verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toMatch(/it proposes no fix and no direction for one/i);
    expect(prompt).toMatch(
      /neither does what you say about whether a human decision is needed/i,
    );
  });

  it("may still quote a limit, naming its source, and still names a collision", () => {
    const prompt = verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toMatch(
      /may quote a limit the Ticket, a documented decision or another criterion sets, naming where it comes from/i,
    );
    expect(prompt).toMatch(/a human decision is needed, naming what it collides with/i);
  });

  it("leaves a Note's `next` carrying the fix", () => {
    expect(verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS)).toMatch(
      /`next` is the fix, or the decision a human has to take/i,
    );
  });

  it("is a lead to the fix Stage, in the section that carries it, and the cause is the Stage's to find", () => {
    const section = failureSectionOf(fixPrompt(url, UNMET, BASE, "", OTHER_TARGET, NO_CHECKS));

    expect(section).toMatch(/a fix this evidence proposes is a lead, not the answer/i);
    expect(section).toMatch(/find the cause yourself/i);
  });

  it("sends the fix Stage after a fix of the cause within the Ticket's scope first", () => {
    expect(fixPrompt(url, UNMET, BASE, "", OTHER_TARGET, NO_CHECKS)).toMatch(
      /look for a fix of the cause you found within the scope this Ticket sets before you settle for a narrower one/i,
    );
  });

  it("has the fix Stage test with inputs built from the cause, and its regression test cover the cause", () => {
    const prompt = fixPrompt(url, UNMET, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).toMatch(
      /before you commit, test your fix with inputs built from the cause you found, of the kind a verify Stage trying to falsify the criterion would try, and not only with the counterexample you were given/i,
    );
    expect(prompt).toMatch(/your regression test covers the cause, not only that counterexample/i);
  });

  it("is not raised with a fix Stage sent in for anything but unmet criteria", () => {
    for (const kind of OTHER_KINDS) {
      const prompt = fixPrompt(url, { ...FAILED_CI, kind }, BASE, "", OTHER_TARGET, NO_CHECKS);

      expect(prompt).not.toMatch(/is a lead, not the answer/i);
      expect(prompt).not.toMatch(/find the cause yourself/i);
      expect(prompt).not.toMatch(/a fix of the cause you found within the scope/i);
      expect(prompt).not.toMatch(/inputs built from the cause/i);
      expect(prompt).not.toMatch(/regression test covers the cause/i);
    }
  });
});

describe("a verify after a fix for unmet criteria", () => {
  const PREVIOUS = "- it works — npm test is red";

  it("is given the first verdict's unmet criteria with their evidence", () => {
    const prompt = verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS, undefined, PREVIOUS);

    expect(prompt).toContain(`\`\`\`\n${PREVIOUS}\n\`\`\``);
    expect(prompt).toMatch(/met only when that counterexample is gone and the whole criterion holds/i);
  });

  it("is told nothing of the kind on a first verify", () => {
    const prompt = verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).not.toMatch(/counterexample is gone/i);
    expect(prompt).not.toMatch(/judged unmet before/i);
  });
});

describe("the conflict Stage's reach", () => {
  it("allows a file the conflict did not touch only to repair what the merge broke", () => {
    const prompt = conflictPrompt(url, CONFLICT, BASE, "", OTHER_TARGET, NO_CHECKS);

    expect(prompt).not.toMatch(/touch no file the conflict did not/i);
    expect(prompt).toMatch(
      /change a file the conflict did not touch only to repair what the merge itself broke/i,
    );
    expect(prompt).toMatch(/implement nothing new/i);
    expect(prompt).toMatch(/change no behaviour this Ticket's Acceptance Criteria cover/i);
  });
});

describe("the body, the problem and the solution", () => {
  const implement = () => implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS);
  const fix = (prose = {}) =>
    fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS, undefined, prose);

  it("has the implement Stage answer all three for the whole branch beside title, after the review's fixes", () => {
    expect(implement()).toMatch(
      /Once the review's fixes are committed, answer a `body`, a `problem` and a `solution` beside `title`, each written for the whole branch/,
    );
  });

  it.each([
    ["implement", implement],
    ["fix", () => fix()],
  ])("puts the Target's own shapes before the pr skill's in the %s prompt", (_, prompt) => {
    const text = prompt();

    expect(text).toContain(
      "in the shape this repository's contributing guide or its `.github/PULL_REQUEST_TEMPLATE.md` sets, when either sets a pull request body's sections or content beyond the `Closes` line; where neither does, invoke `/mattpocock-skills:pr` by that full name",
    );
    expect(text).toContain("as this repository's contributing guide sets a commit body, when it does");
  });

  it.each([
    ["implement", implement],
    ["fix", () => fix()],
  ])("states the problem and solution shape itself in the %s prompt", (_, prompt) => {
    expect(prompt()).toContain(
      "the problem is the state before the change and its effect, and the solution is what the change does and why, each in at most two sentences, readable without opening the Ticket, leaving out what the diff and the body already show",
    );
  });

  it.each([
    ["implement", implement],
    ["fix", () => fix()],
  ])("keeps titles, closing keywords, screenshots and local paths out of all three in the %s prompt", (_, prompt) => {
    expect(prompt()).toContain(
      "None of the three carries a title, a closing keyword (`Closes`, `Fixes`, `Resolves`) before an issue reference, a screenshot or a local path",
    );
  });

  it("hands the fix Stage the answers so far, each under its field, and has it revise only what its fix changes", () => {
    const prompt = fix({ body: "## Summary\n\n```text\na\n```", problem: "There was no flag." });

    expect(prompt).toContain("## What the branch's answers say now");
    expect(prompt).toContain("### `body`\n\n````\n## Summary\n\n```text\na\n```\n````");
    expect(prompt).toContain("### `problem`\n\n```\nThere was no flag.\n```");
    expect(prompt).not.toContain("### `solution`");
    expect(prompt).toMatch(
      /When your fix changes what one of them says, answer that one revised for the whole branch/,
    );
    expect(prompt).toMatch(/Answer each one your fix leaves true as an empty string, which keeps it/);
  });

  it("hands the fix Stage the title answered so far first, under its field", () => {
    const prompt = fix({ title: "feat: add a flag", body: "## Summary" });

    expect(prompt).toContain("## What the branch's answers say now\n\n### `title`\n\n```\nfeat: add a flag\n```");
    expect(prompt.indexOf("### `title`")).toBeLessThan(prompt.indexOf("### `body`"));
  });

  it("gives the fix Stage no answers section when none has been answered", () => {
    expect(fix()).not.toContain("## What the branch's answers say now");
  });
});

describe("the language a Stage writes in", () => {
  const RULE =
    "in the language this repository's contributing guide sets for issues and commits, and where it sets none, in the language the Ticket is written in. A criterion's text stays as the Ticket writes it.";

  it("covers every answer of the two code Stages", () => {
    for (const prompt of [
      implementPrompt(url, BASE, "", OTHER_TARGET, NO_CHECKS),
      fixPrompt(url, FAILED_CI, BASE, "", OTHER_TARGET, NO_CHECKS),
    ]) {
      expect(prompt).toContain(
        `- Write your Notes, \`title\`, \`body\`, \`problem\`, \`solution\` and \`noCommitReason\` ${RULE}`,
      );
    }
  });

  it("covers the verify Stage's Notes and its verdict's evidence", () => {
    expect(verifyPrompt(url, "", OTHER_TARGET, NO_CHECKS)).toContain(
      `- Write your Notes and the verdict's evidence ${RULE}`,
    );
  });
});
