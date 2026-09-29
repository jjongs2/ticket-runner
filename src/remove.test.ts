import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { CLAUDE_SECTION, CONVENTIONS_PATH, conventionsDoc } from "./conventions.js";
import { initTarget } from "./init.js";
import { LOCK_BRANCH } from "./lock.js";
import type { LockHolder } from "./ports/workspace.js";
import { removeTarget } from "./remove.js";
import { STATE_BRANCH } from "./resume.js";
import { STAGE_ENV_VAR } from "./stage-guard.js";
import {
  ANOTHER_HOST,
  FakeAgentRunner,
  FakeTracker,
  FakeWorkspace,
  THIS_HOST,
} from "./testing/fakes.js";
import { notesIssue } from "./templates.js";

let repoRoot: string;
let tracker: FakeTracker;
let workspace: FakeWorkspace;

const VERSION = "0.5.2+331d79c";

/** The five triage labels Planning shares with the pipeline. */
const PLANNING_LABELS = [
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
];

function write(path: string, contents: string): void {
  mkdirSync(dirname(join(repoRoot, path)), { recursive: true });
  writeFileSync(join(repoRoot, path), contents);
}

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

/** Every file and directory under the root, by path, as the Target's whole visible state. */
function snapshot(root = repoRoot, prefix = ""): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      entries[`${path}/`] = "";
      Object.assign(entries, snapshot(join(root, entry.name), path));
    } else {
      entries[path] = readFileSync(join(root, entry.name), "utf8");
    }
  }
  return entries;
}

/** `init`, as the human who tried the pipeline on this Target ran it. */
async function init(): Promise<void> {
  await initTarget({
    repoRoot,
    version: VERSION,
    config: loadConfig(repoRoot, VERSION),
    tracker,
    runner: new FakeAgentRunner(),
    env: {},
    log: () => {},
    error: () => {},
  });
}

/** The worktree path a Run gives Ticket `ticket`. */
function worktree(ticket: number): string {
  return join(repoRoot, ".worktrees", `ticket-${ticket}`);
}

/**
 * What a Run leaves behind: its logs, a handed-off Ticket's worktree and
 * State, a local branch without a worktree, a pushed branch with its pull
 * request, the standing Notes issue, and a lock it took and gave back.
 */
async function aRunWorkedHere(): Promise<void> {
  write(".ticket-runner/runs/r1/version", `${VERSION}\n`);
  workspace.worktrees.set(worktree(12), "agent/12-some-title");
  workspace.branches.add("agent/12-some-title");
  workspace.branches.add("agent/7-other-title");
  workspace.remoteBranches.add("agent/12-some-title");
  tracker.pullRequests.push({
    number: 40,
    base: "main",
    head: "agent/12-some-title",
    title: "feat: some title",
    body: "",
    draft: true,
    merged: false,
  });
  workspace.recordState({
    ticket: 12,
    branch: "agent/12-some-title",
    state: "implemented",
    fixUsed: false,
    pullRequest: 40,
    runId: "r1",
    updatedAt: "2026-09-20T22:07:13.000Z",
  });
  tracker.addIssue({ number: 88, ...notesIssue(), labels: ["needs-triage"] });
  tracker.addIssue({ number: 12, closed: true, labels: ["in-progress"] });
  await workspace.takeRunLock({ pid: 111, command: "ticket-runner run", runId: "r1", startedAt: "t" });
  await workspace.releaseRunLock();
}

/** One `remove`, in a human's terminal, answering yes unless the test says otherwise. */
async function remove(
  overrides: {
    env?: NodeJS.ProcessEnv;
    yes?: boolean;
    interactive?: boolean;
    answer?: string;
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const code = await removeTarget({
    repoRoot,
    version: VERSION,
    config: loadConfig(repoRoot, VERSION),
    tracker,
    workspace,
    yes: overrides.yes ?? false,
    interactive: overrides.interactive ?? true,
    ask: async (question) => {
      asked.push(question);
      return overrides.answer ?? "y";
    },
    runId: "remove-run",
    command: "ticket-runner remove",
    env: overrides.env ?? {},
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), asked };
}

/** The lines of one group of the report, without their indent. */
function group(out: string, heading: string): string[] {
  const lines = out.split("\n");
  const start = lines.indexOf(`${heading}:`);
  if (start === -1) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  ")) break;
    body.push(line.slice(2));
  }
  return body;
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "ticket-runner-remove-"));
  tracker = new FakeTracker();
  workspace = new FakeWorkspace();
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("taking the pipeline out of a Target it set up", () => {
  it("leaves the Target as it was before init, and exits 0", async () => {
    write("README.md", "# acme\n");
    write(".gitignore", "node_modules/\n");
    write("CLAUDE.md", "# acme\n\nBe kind.\n");
    write(".claude/settings.json", "{}\n");
    const before = snapshot();
    await init();
    await aRunWorkedHere();

    const { code, out } = await remove();

    expect(code).toBe(0);
    expect(snapshot()).toEqual(before);
    expect(out.split("\n").at(-1)).toBe("Done: the pipeline has gone from this Target.");
  });

  it("removes the worktrees, branches, label, State and lock a Run left", async () => {
    await init();
    await aRunWorkedHere();

    await remove();

    expect(workspace.worktrees.size).toBe(0);
    expect(workspace.branches.size).toBe(0);
    expect(tracker.labels).toEqual(new Set(PLANNING_LABELS));
    expect(tracker.issue(12).labels).toEqual([]);
    expect(await workspace.hasRemoteBranch(STATE_BRANCH)).toBe(false);
    expect(await workspace.hasRemoteBranch(LOCK_BRANCH)).toBe(false);
  });

  it("deletes the lock branch after every other removal", async () => {
    await init();
    await aRunWorkedHere();

    await remove();

    expect(workspace.calls.at(-1)).toBe(`deleteRemoteBranch:${LOCK_BRANCH}`);
    expect(workspace.calls).toContain(`deleteRemoteBranch:${STATE_BRANCH}`);
  });

  it("deletes files a human edited, and a CLAUDE.md or .gitignore that held nothing else", async () => {
    await init();
    write("ticket-runner.json", '{ "lanes": 2 }\n');
    write(CONVENTIONS_PATH, "# mine now\n");

    const { code, out } = await remove();

    expect(code).toBe(0);
    expect(snapshot()).toEqual({});
    expect(group(out, "Removed")).toEqual([
      "✓ docs/agents/pipeline-conventions.md",
      "✓ .claude/skills/ticket-runner/SKILL.md",
      "✓ CLAUDE.md: deleted, because the section `init` wrote was all it held",
      "✓ .gitignore: deleted, because the entries `init` wrote were all it held",
      "✓ docs/agents/, left empty",
      "✓ docs/, left empty",
      "✓ .claude/skills/ticket-runner/, left empty",
      "✓ .claude/skills/, left empty",
      "✓ .claude/, left empty",
      "✓ ticket-runner.json",
    ]);
  });

  it("reports in the shape of the template: the Version, three groups, and the exit code in words", async () => {
    await init();
    await aRunWorkedHere();

    const { out } = await remove({ yes: true });

    const lines = out.split("\n");
    expect(lines[0]).toBe(`ticket-runner ${VERSION} remove · ${repoRoot}`);
    const headings = lines.filter((line) => /^\S.*:$/.test(line));
    expect(headings).toEqual(["Removed:", "GitHub:", "Left for you:"]);
    expect(group(out, "GitHub")).toEqual([
      "✓ the `in-progress` label, from every issue that wore it",
      `✓ the \`${STATE_BRANCH}\` branch`,
      `✓ the \`${LOCK_BRANCH}\` branch`,
    ]);
    expect(group(out, "Removed")).toEqual(
      expect.arrayContaining([
        "✓ .ticket-runner/",
        "✓ .worktrees/ticket-12, and its branch agent/12-some-title",
        "✓ agent/7-other-title, a local branch",
      ]),
    );
  });
});

describe("what remove leaves for the human", () => {
  it("names the Planning labels, the merge settings, the work on GitHub and the Notes issue, and touches none", async () => {
    await init();
    await aRunWorkedHere();
    tracker.squashMergeEnabled = true;
    workspace.remoteBranches.add("agent/9-another-title");

    const { out } = await remove();

    expect(group(out, "Left for you")).toEqual([
      ...PLANNING_LABELS.map(
        (name) => `label \`${name}\`: Planning uses it too — \`gh label delete ${name}\` removes it`,
      ),
      "merge settings: squash merging and deleting a pull request's branch when it merges are left as they are, since this repository may have had them before `init` — `gh repo edit --enable-squash-merge=false` or `gh repo edit --delete-branch-on-merge=false` turns one off",
      "branch `agent/12-some-title` on GitHub: pull request #40 is open on it",
      "branch `agent/9-another-title` on GitHub: no pull request is open on it",
      "issue #88: the standing Notes issue, left open with the Notes on it",
      `#12: no Run can resume it any more, because its State file, and any hand-off transcripts kept beside it, went with \`${STATE_BRANCH}\``,
      "comments on issues: the progress, hand-off and Note comments Runs wrote are left as they are, since they are addressed to humans",
      "nothing was committed: review the changes with `git status` and commit them yourself",
    ]);
    expect(tracker.squashMergeEnabled).toBe(true);
    expect(tracker.deleteBranchOnMergeEnabled).toBe(true);
    expect(workspace.remoteBranches).toEqual(new Set(["agent/12-some-title", "agent/9-another-title"]));
    expect(tracker.pullRequests[0]?.merged).toBe(false);
    expect(tracker.issue(88).closed).toBe(false);
    expect(tracker.calls.filter((call) => call.startsWith("comment"))).toEqual([]);
  });

  it("keeps a CLAUDE.md section and a .gitignore entry that are not init's text, and says so", async () => {
    write(".gitignore", "# ours\n.worktrees/\n");
    await init();
    write("CLAUDE.md", read("CLAUDE.md").replace("Read it before", "Read it well before"));

    const { code, out } = await remove();

    expect(code).toBe(0);
    expect(read(".gitignore")).toBe("# ours\n.worktrees/\n");
    expect(read("CLAUDE.md")).toContain(CONVENTIONS_PATH);
    expect(group(out, "Left for you")).toEqual(
      expect.arrayContaining([
        `CLAUDE.md: the section pointing at ${CONVENTIONS_PATH} is not the text \`init\` writes, so it stays`,
        ".gitignore: `.worktrees/` stays, because it is not under the comment `init` writes it with",
      ]),
    );
  });

  it("takes init's section out of a CLAUDE.md that says other things, before and after it", async () => {
    write("CLAUDE.md", "# acme\n");
    await init();
    write("CLAUDE.md", `${read("CLAUDE.md")}\n## Later\n\nAdded after init.\n`);

    await remove();

    expect(read("CLAUDE.md")).toBe("# acme\n\n## Later\n\nAdded after init.\n");
  });

  it("keeps what else is under .worktrees, and its .gitignore entry", async () => {
    await init();
    await aRunWorkedHere();
    write(".worktrees/scratch/notes.txt", "mine\n");

    const { out } = await remove();

    expect(snapshot()).toEqual({
      ".gitignore": "# Pipeline worktrees, one per Ticket.\n.worktrees/\n",
      ".worktrees/": "",
      ".worktrees/scratch/": "",
      ".worktrees/scratch/notes.txt": "mine\n",
    });
    expect(group(out, "Left for you")).toContain(
      ".worktrees/: holds scratch besides the pipeline's worktrees, so it stays, and so does its `.gitignore` entry",
    );
  });

  it("removes .worktrees and its entry once the pipeline's worktrees were all it held", async () => {
    await init();
    await aRunWorkedHere();
    mkdirSync(worktree(12), { recursive: true });
    // The fake removes no directory, as the git-backed Workspace does.
    workspace.removeWorktree = async ({ path }) => {
      rmSync(path, { recursive: true, force: true });
      workspace.worktrees.delete(path);
    };

    const { out } = await remove();

    expect(snapshot()).toEqual({});
    expect(group(out, "Removed")).toContain("✓ .worktrees/, left empty");
  });
});

describe("a removal that fails", () => {
  it("leaves the rest done, marks it, releases the lock and exits 1", async () => {
    await init();
    await aRunWorkedHere();
    workspace.failing.set(`deleteRemoteBranch:${STATE_BRANCH}`, new Error("remote hung up"));

    const { code, out } = await remove();

    expect(code).toBe(1);
    expect(group(out, "GitHub")).toEqual([
      "✓ the `in-progress` label, from every issue that wore it",
      `✗ the \`${STATE_BRANCH}\` branch: remote hung up`,
      "✓ the Run lock, released to free",
    ]);
    expect(group(out, "Left for you")).toContain(
      `${LOCK_BRANCH}: released rather than deleted, because a removal above failed — \`ticket-runner remove\` again deletes it with the rest`,
    );
    expect(out.split("\n").at(-1)).toBe(
      "Not done: 1 removal failed — run `ticket-runner remove` again to remove what is left.",
    );
    expect(workspace.lock).toBeUndefined();
    expect(await workspace.hasRemoteBranch(LOCK_BRANCH)).toBe(true);
    expect(Object.keys(snapshot())).toEqual(["ticket-runner.json"]);
  });

  it("keeps the config file, which names the labels, for the next run", async () => {
    await init();
    write("ticket-runner.json", '{ "labels": { "inProgress": "wip" } }\n');
    tracker.labels.add("wip");
    tracker.deleteLabelFailure = new Error("HTTP 502");

    const first = await remove();

    expect(first.code).toBe(1);
    expect(group(first.out, "GitHub")).toContain("✗ the `wip` label, from every issue that wore it: HTTP 502");
    expect(group(first.out, "Removed")).not.toContain("✓ ticket-runner.json");
    expect(group(first.out, "Left for you")).toContain(
      "ticket-runner.json: kept, because a removal above failed and it names the labels the next `ticket-runner remove` looks for — that run deletes it with the rest",
    );
    expect(read("ticket-runner.json")).toBe('{ "labels": { "inProgress": "wip" } }\n');

    tracker.deleteLabelFailure = undefined;
    const second = await remove();

    expect(second.code).toBe(0);
    expect(group(second.out, "Removed")).toEqual(["✓ ticket-runner.json"]);
    expect(tracker.labels.has("wip")).toBe(false);
    expect(snapshot()).toEqual({});
    expect(await workspace.hasRemoteBranch(LOCK_BRANCH)).toBe(false);
  });

  it("looks for Stranded Tickets under the label the kept config file names", async () => {
    await init();
    write("ticket-runner.json", '{ "labels": { "inProgress": "wip" } }\n');
    tracker.labels.add("wip");
    tracker.deleteLabelFailure = new Error("HTTP 502");
    await remove();
    tracker.deleteLabelFailure = undefined;
    tracker.addIssue({ number: 15, labels: ["wip"] });

    const { code, err } = await remove();

    expect(code).toBe(2);
    expect(err).toContain("#15 still carries the `wip` label");
  });

  it("is finished by running remove again", async () => {
    await init();
    await aRunWorkedHere();
    workspace.failing.set(`deleteRemoteBranch:${STATE_BRANCH}`, new Error("remote hung up"));
    await remove();

    const { code, out } = await remove();

    expect(code).toBe(0);
    expect(group(out, "Removed")).toEqual(["✓ ticket-runner.json"]);
    expect(group(out, "GitHub")).toEqual([
      `✓ the \`${STATE_BRANCH}\` branch`,
      `✓ the \`${LOCK_BRANCH}\` branch`,
    ]);
    expect(await workspace.hasRemoteBranch(LOCK_BRANCH)).toBe(false);
  });

  it("releases the lock when deleting the lock branch itself fails", async () => {
    await init();
    workspace.failing.set(`deleteRemoteBranch:${LOCK_BRANCH}`, new Error("protected branch"));

    const { code, out } = await remove();

    expect(code).toBe(1);
    expect(group(out, "GitHub")).toEqual([
      "✓ the `in-progress` label, from every issue that wore it",
      `✗ the \`${LOCK_BRANCH}\` branch: protected branch`,
      "✓ the Run lock, released to free",
    ]);
    expect(workspace.lock).toBeUndefined();
  });

  it("keeps the state branch when the Tickets on it cannot be read, so none goes unnamed", async () => {
    await init();
    await aRunWorkedHere();
    workspace.readAllStates = async () => {
      throw new Error("fetch failed");
    };

    const { code, out } = await remove();

    expect(code).toBe(1);
    expect(group(out, "GitHub")).toContain(`✗ the \`${STATE_BRANCH}\` branch: fetch failed`);
    expect(workspace.state(12)).toBeDefined();
  });

  it("names what it kept after the Planning labels and the work on GitHub, as the template orders them", async () => {
    await init();
    await aRunWorkedHere();
    write(".worktrees/scratch/notes.txt", "mine\n");

    const left = group((await remove()).out, "Left for you");

    expect(left.at(-2)).toBe(
      ".worktrees/: holds scratch besides the pipeline's worktrees, so it stays, and so does its `.gitignore` entry",
    );
  });
});

describe("a Target with nothing to remove", () => {
  it("reports nothing to remove, takes no lock and exits 0", async () => {
    write("README.md", "# acme\n");
    tracker.labels = new Set(["needs-triage"]);

    const { code, out, asked } = await remove({ interactive: false });

    expect(code).toBe(0);
    expect(workspace.calls).not.toContain("takeRunLock");
    expect(await workspace.hasRemoteBranch(LOCK_BRANCH)).toBe(false);
    expect(asked).toEqual([]);
    expect(group(out, "Removed")).toEqual(["nothing to remove"]);
    expect(group(out, "GitHub")).toEqual(["nothing to remove"]);
    expect(group(out, "Left for you")).toContain(
      "label `needs-triage`: Planning uses it too — `gh label delete needs-triage` removes it",
    );
    expect(group(out, "Left for you")).not.toContain(
      "nothing was committed: review the changes with `git status` and commit them yourself",
    );
    expect(out.split("\n").at(-1)).toBe(
      "Nothing to remove: ticket-runner has not set this Target up.",
    );
  });

  it("is what a Target is once remove has taken everything out", async () => {
    await init();
    await aRunWorkedHere();
    await remove();
    workspace.calls = [];

    const { code, out } = await remove();

    expect(code).toBe(0);
    expect(workspace.calls).not.toContain("takeRunLock");
    expect(out.split("\n").at(-1)).toBe(
      "Nothing to remove: ticket-runner has not set this Target up.",
    );
  });
});

describe("asking first", () => {
  it("lists what it is about to remove and asks, holding the lock", async () => {
    await init();
    await aRunWorkedHere();
    let holder: LockHolder | undefined;

    const { out, asked } = await removeAsking("y", () => {
      holder = workspace.lock?.holder;
    });

    expect(asked).toEqual(["Remove all of this? Nothing will be committed. [y/N] "]);
    expect(holder).toMatchObject({ command: "ticket-runner remove", runId: "remove-run" });
    expect(group(out, "About to remove")).toEqual([
      "docs/agents/pipeline-conventions.md",
      ".claude/skills/ticket-runner/SKILL.md",
      "CLAUDE.md, because the section `init` wrote is all it holds",
      ".ticket-runner/",
      ".worktrees/ticket-12, and its branch agent/12-some-title",
      "agent/7-other-title, a local branch",
      ".gitignore: the entries `init` wrote",
      "any directory this leaves empty",
      "the `in-progress` label",
      `the \`${STATE_BRANCH}\` branch`,
      "ticket-runner.json",
      `the \`${LOCK_BRANCH}\` branch`,
    ]);
  });

  it.each(["y", "Y", "yes", " YES "])("takes %j as yes", async (answer) => {
    await init();

    expect((await remove({ answer })).code).toBe(0);
  });

  it.each(["", "n", "no", "yep"])("takes %j as no: nothing changes, and the lock is free", async (answer) => {
    await init();
    await aRunWorkedHere();
    const before = snapshot();

    const { code, err } = await remove({ answer });

    expect(code).toBe(2);
    expect(err).toBe("Nothing was removed. Run `ticket-runner remove` again when you want it gone.");
    expect(snapshot()).toEqual(before);
    expect(workspace.lock).toBeUndefined();
    expect(tracker.labels.has("in-progress")).toBe(true);
    expect(await workspace.hasRemoteBranch(STATE_BRANCH)).toBe(true);
  });

  it("asks nothing with --yes", async () => {
    await init();

    const { code, asked, out } = await remove({ yes: true, interactive: false });

    expect(code).toBe(0);
    expect(asked).toEqual([]);
    expect(out).not.toContain("About to remove:");
  });

  /** `remove` answering `answer`, with `whileAsked` run at the moment it is asked. */
  async function removeAsking(answer: string, whileAsked: () => void) {
    const asked: string[] = [];
    const out: string[] = [];
    await removeTarget({
      repoRoot,
      version: VERSION,
      config: loadConfig(repoRoot, VERSION),
      tracker,
      workspace,
      yes: false,
      interactive: true,
      ask: async (question) => {
        asked.push(question);
        whileAsked();
        return answer;
      },
      runId: "remove-run",
      command: "ticket-runner remove",
      env: {},
      log: (line) => out.push(line),
      error: () => {},
    });
    return { asked, out: out.join("\n") };
  }
});

describe("refusing before anything changes", () => {
  /**
   * A Target a Run worked in, arranged as the test says, refused by `act`: the
   * refusal's message, once the Target and the remote are shown to be as the
   * arrangement left them.
   */
  async function unchanged(
    arrange: () => void,
    act: () => Promise<{ code: number; err: string }>,
  ): Promise<string> {
    await init();
    await aRunWorkedHere();
    arrange();
    workspace.calls = [];
    const before = snapshot();
    const lock = structuredClone(workspace.lock);
    const labels = new Set(tracker.labels);
    const { code, err } = await act();
    expect(code).toBe(2);
    expect(snapshot()).toEqual(before);
    expect(workspace.lock).toEqual(lock);
    expect(tracker.labels).toEqual(labels);
    expect(workspace.worktrees.size).toBe(1);
    expect(await workspace.hasRemoteBranch(STATE_BRANCH)).toBe(true);
    return err;
  }

  it("refuses a shell carrying the Stage mark before reading anything", async () => {
    await init();
    tracker.calls = [];

    const { code, err } = await remove({ env: { [STAGE_ENV_VAR]: "implement" } });

    expect(code).toBe(2);
    expect(err).toMatch(/^Refusing to start: TICKET_RUNNER_STAGE is set/);
    expect(tracker.calls).toEqual([]);
    expect(workspace.calls).toEqual([]);
  });

  it("refuses a cloud Host, and says to run it on a workstation", async () => {
    const err = await unchanged(
      () => {},
      () => remove({ env: { CLAUDE_CODE_REMOTE: "true" } }),
    );

    expect(err).toMatch(/cloud Host/);
    expect(err).toMatch(/Run `ticket-runner remove` on a workstation instead\.$/);
  });

  it("refuses a gh that is not installed, in init's words", async () => {
    const err = await unchanged(
      () => {
        tracker.authenticationAnswer = "not-installed";
      },
      () => remove(),
    );

    expect(err).toBe(
      "Refusing to remove: `gh` is not installed — install the GitHub CLI from https://cli.github.com, then `ticket-runner remove` again.",
    );
  });

  it("refuses a gh that is not authenticated, in init's words", async () => {
    const err = await unchanged(
      () => {
        tracker.authenticationAnswer = "unauthenticated";
      },
      () => remove(),
    );

    expect(err).toBe(
      "Refusing to remove: `gh` is not authenticated — run `gh auth login`, then `ticket-runner remove` again.",
    );
  });

  it("refuses a Target a newer Version set up, and names the upgrade", async () => {
    const err = await unchanged(
      () => write(CONVENTIONS_PATH, conventionsDoc("0.6.0")),
      () => remove(),
    );

    expect(err).toBe(
      "Refusing to remove: 0.6.0 set this Target up and this is 0.5.2, so it may have left things this Version does not know to remove. Upgrade with `npm install -g ticket-runner`, then run `ticket-runner remove` again.",
    );
  });

  it("refuses without a terminal or --yes, before taking the lock", async () => {
    const err = await unchanged(
      () => {},
      () => remove({ interactive: false }),
    );

    expect(err).toBe(
      "Refusing to remove: there is no terminal to ask whether to go ahead. Run `ticket-runner remove --yes` to remove without asking.",
    );
    expect(workspace.calls).not.toContain("takeRunLock");
  });

  const holder = (overrides: Partial<LockHolder> = {}): LockHolder => ({
    host: THIS_HOST,
    pid: 4242,
    command: "ticket-runner run",
    runId: "night-run",
    startedAt: "2026-09-20T22:07:13.000Z",
    ...overrides,
  });

  it("refuses a lock a live Run on this Host holds, and names it", async () => {
    const err = await unchanged(
      () => {
        workspace.lock = { holder: holder(), running: true };
      },
      () => remove({ yes: true }),
    );

    expect(err).toBe(
      "Refusing to remove: `ticket-runner run` (run night-run, pid 4242) holds the Run lock on this Host, started 2026-09-20T22:07:13.000Z. Wait for it to finish, or ask it to with `ticket-runner stop`, then run `ticket-runner remove` again.",
    );
  });

  it("refuses a lock whose Run on this Host has gone, and takes nothing over", async () => {
    const err = await unchanged(
      () => {
        workspace.lock = { holder: holder(), running: false };
      },
      () => remove({ yes: true }),
    );

    expect(err).toMatch(
      /^Refusing to remove: `ticket-runner run` \(run night-run, pid 4242\) holds the Run lock, but its process on this Host has gone\. `remove` takes over no lock/,
    );
    expect(err).toMatch(/`lock\.json` that reads `\{ "held": false \}` to the `ticket-runner\/lock` branch/);
    expect(workspace.calls).not.toContain("takeOverRunLock");
  });

  it("refuses a lock a Run on another Host holds, and names that Host", async () => {
    const err = await unchanged(
      () => {
        workspace.lock = { holder: holder({ host: ANOTHER_HOST }), running: true };
      },
      () => remove({ yes: true }),
    );

    expect(err).toMatch(
      /^Refusing to remove: `ticket-runner run` \(run night-run\) holds the Run lock from the cloud Host of session `session_01other`, started 2026-09-20T22:07:13\.000Z\. Wait for it to finish or, if it is gone, commit/,
    );
  });

  it("refuses a Stranded Ticket, names it and leaves the lock free", async () => {
    const err = await unchanged(
      () => tracker.addIssue({ number: 15, labels: ["in-progress"] }),
      () => remove({ yes: true }),
    );

    expect(err).toBe(
      "Refusing to remove: #15 still carries the `in-progress` label, so it is a Stranded Ticket a Run was killed holding. Finish it with `ticket-runner run`, or relabel it, then run `ticket-runner remove` again.",
    );
    expect(workspace.calls).toContain("releaseRunLock");
  });

  it("refuses a worktree holding work GitHub lacks, names each and which, and leaves the lock free", async () => {
    const err = await unchanged(
      () => {
        workspace.uncommittedIn.add(worktree(12));
        workspace.unpushedIn.add(worktree(12));
      },
      () => remove({ yes: true }),
    );

    expect(err).toBe(
      [
        "Refusing to remove: these worktrees hold work GitHub does not have, which removing them would lose:",
        "  .worktrees/ticket-12: uncommitted changes, and commits its branch on the remote does not have",
        "Push what is worth keeping, and take out a worktree nothing in is wanted with `git worktree remove --force <path>`, then run `ticket-runner remove` again.",
      ].join("\n"),
    );
  });
});

describe("the section init writes", () => {
  it("is the text remove recognises", async () => {
    await init();

    expect(read("CLAUDE.md")).toBe(CLAUDE_SECTION);
  });
});
