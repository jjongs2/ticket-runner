import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { StageRequest } from "../ports/agent-runner.js";
import { nestedRunRefusal } from "../stage-guard.js";
import { execution, failedExecution } from "../testing/executions.js";
import { ClaudeAgentRunner } from "./claude-agent-runner.js";
import type { ExecOptions, Execution } from "./exec.js";

let logDir: string;
let calls: { command: string; args: string[]; options: ExecOptions }[];

const WARNING = "a warning\n";

/** One of the Stage's files in the log directory this test was given. */
function stageFile(suffix: string): string {
  return join(logDir, `implement.${suffix}`);
}

function transcript(...events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

const SUCCESS = transcript(
  { type: "system", subtype: "init", session_id: "abc" },
  { type: "assistant", message: { content: [{ type: "text", text: "working" }] } },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 12,
    duration_ms: 4200,
    result: "done",
  },
);

function runner(
  result: Execution | ((args: string[]) => Execution),
  exists: (path: string) => boolean = () => true,
) {
  return new ClaudeAgentRunner({
    exists,
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      const recorded = typeof result === "function" ? result(args) : result;
      // A real child prints its output before it exits, not after.
      if (recorded.stdout !== "") options.onStdout?.(recorded.stdout);
      if (recorded.stderr !== "") options.onStderr?.(recorded.stderr);
      return recorded;
    },
  });
}

function request(overrides: Partial<StageRequest> = {}): StageRequest {
  return {
    stage: "implement",
    prompt: "/mattpocock-skills:implement https://example.com/issues/2",
    cwd: "/repo/.worktrees/ticket-2",
    model: "claude-opus-5-5",
    effort: "high",
    maxTurns: 300,
    maxMinutes: 60,
    permissionMode: "auto",
    logDir,
    ...overrides,
  };
}

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "ticket-runner-logs-"));
  calls = [];
});

describe("the preflight", () => {
  const VERSION = "2.0.31 (Claude Code)\n";
  const PLUGINS = "mattpocock-skills@1.2.3 (enabled)\nother-plugin@0.1.0 (enabled)\n";

  /** A runner that answers each preflight question with its own output. */
  function asked(version: Execution, plugins: Execution) {
    return runner((args) => (args[0] === "--version" ? version : plugins));
  }

  it("asks claude for its version and then for its plugins", async () => {
    const preflight = await asked(
      execution({ stdout: VERSION }),
      execution({ stdout: PLUGINS }),
    ).preflight();

    expect(calls.map((call) => call.args)).toEqual([["--version"], ["plugin", "list"]]);
    expect(calls[0]?.command).toBe("claude");
    expect(preflight).toEqual({ runs: true, plugin: true });
  });

  it("reports the plugin as missing when claude lists other plugins", async () => {
    const preflight = await asked(
      execution({ stdout: VERSION }),
      execution({ stdout: "other-plugin@0.1.0 (enabled)\n" }),
    ).preflight();

    expect(preflight).toEqual({ runs: true, plugin: false });
  });

  it("reports the plugin as missing when claude cannot list its plugins", async () => {
    const preflight = await asked(
      execution({ stdout: VERSION }),
      failedExecution("unknown command `plugin`"),
    ).preflight();

    expect(preflight).toEqual({ runs: true, plugin: false });
  });

  it("asks nothing further when claude cannot be run at all", async () => {
    const missing = new ClaudeAgentRunner({
      run: async (command, args, options) => {
        calls.push({ command, args, options });
        throw new Error("spawn claude ENOENT");
      },
    });

    expect(await missing.preflight()).toEqual({ runs: false, plugin: false });
    expect(calls.map((call) => call.args)).toEqual([["--version"]]);
  });

  it("reports claude as unrunnable when it exits non-zero on its own version", async () => {
    const preflight = await asked(
      failedExecution("not installed"),
      execution({ stdout: PLUGINS }),
    ).preflight();

    expect(preflight).toEqual({ runs: false, plugin: false });
  });
});

describe("the command line", () => {
  it("runs headless with the prompt, model, effort, limits and permission settings", async () => {
    await runner(execution({ stdout: SUCCESS })).run(request());
    const args = calls[0]?.args ?? [];

    expect(calls[0]?.command).toBe("claude");
    expect(args).toContain("--print");
    expect(args).toContain("/mattpocock-skills:implement https://example.com/issues/2");
    expect(args.join(" ")).toContain("--permission-prompts none");
    expect(args.join(" ")).toContain("--permission-mode auto");
    expect(args.join(" ")).toContain("--model claude-opus-5-5");
    expect(args.join(" ")).toContain("--effort high");
    expect(args.join(" ")).toContain("--max-turns 300");
  });

  it("passes the effort the Stage was given", async () => {
    await runner(execution({ stdout: SUCCESS })).run(request({ effort: "low" }));

    expect(calls[0]?.args.join(" ")).toContain("--effort low");
  });

  it("asks for a stream-json transcript", async () => {
    await runner(execution({ stdout: SUCCESS })).run(request());

    expect(calls[0]?.args.join(" ")).toContain("--output-format stream-json");
    expect(calls[0]?.args).toContain("--verbose");
  });

  it("runs the Stage in the worktree and stops it at the wall-clock limit", async () => {
    await runner(execution({ stdout: SUCCESS })).run(request({ maxMinutes: 20 }));

    expect(calls[0]?.options.cwd).toBe("/repo/.worktrees/ticket-2");
    expect(calls[0]?.options.timeoutMs).toBe(20 * 60_000);
  });

  it("marks the child environment with the Stage, so it cannot start a nested Run", async () => {
    await runner(execution({ stdout: SUCCESS })).run(request());
    expect(calls[0]?.options.extraEnv?.TICKET_RUNNER_STAGE).toBe("implement");

    await runner(execution({ stdout: SUCCESS })).run(request({ stage: "verify" }));
    expect(calls[1]?.options.extraEnv?.TICKET_RUNNER_STAGE).toBe("verify");
  });

  it("gives the child an environment the CLI refuses in, naming the Stage", async () => {
    await runner(execution({ stdout: SUCCESS })).run(request({ stage: "verify" }));

    expect(nestedRunRefusal(calls[0]?.options.extraEnv ?? {})).toMatch(
      /^Refusing to start: TICKET_RUNNER_STAGE is set to `verify`, so this shell belongs to the verify Stage/,
    );
  });

  it("marks each Stage session with a value of its own, which its kill looks for", async () => {
    await runner(execution({ stdout: SUCCESS })).run(request());
    await runner(execution({ stdout: SUCCESS })).run(request());

    const [first, second] = calls.map((call) => call.options);
    expect(first?.extraEnv?.TICKET_RUNNER_SESSION).toMatch(/^[0-9a-f-]{36}$/);
    expect(first?.mark).toEqual({
      name: "TICKET_RUNNER_SESSION",
      value: first?.extraEnv?.TICKET_RUNNER_SESSION,
    });
    expect(second?.extraEnv?.TICKET_RUNNER_SESSION).not.toBe(first?.extraEnv?.TICKET_RUNNER_SESSION);
    expect(second?.mark?.value).toBe(second?.extraEnv?.TICKET_RUNNER_SESSION);
  });

  it("starts the session with no MCP server, not even the account's connectors", async () => {
    await runner(execution({ stdout: SUCCESS })).run(request());

    expect(calls[0]?.args).toContain("--strict-mcp-config");
    expect(calls[0]?.args).not.toContain("--mcp-config");
  });

  it("denies the tools that act beyond the worktree and the session", async () => {
    await runner(execution({ stdout: SUCCESS })).run(request());

    // The option takes every word up to the next one, so another option has
    // to follow the list, or the next argument would be read as a tool.
    expect(calls[0]?.args.join(" ")).toContain(
      "--disallowedTools CronCreate CronDelete RemoteTrigger PushNotification ScheduleWakeup Workflow --",
    );
  });

  it("turns off the Host user's auto memory", async () => {
    await runner(execution({ stdout: SUCCESS })).run(request());

    expect(calls[0]?.options.extraEnv?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });

  it("gives the session bash for its shell where the Host has it", async () => {
    const asked: string[] = [];
    const hasBash = (path: string) => {
      asked.push(path);
      return true;
    };

    await runner(execution({ stdout: SUCCESS }), hasBash).run(request());

    expect(asked).toEqual(["/bin/bash"]);
    expect(calls[0]?.options.extraEnv?.CLAUDE_CODE_SHELL).toBe("/bin/bash");
  });

  it("leaves the shell as it is where the Host has no bash", async () => {
    await runner(execution({ stdout: SUCCESS }), () => false).run(request());

    expect(calls[0]?.options.extraEnv).not.toHaveProperty("CLAUDE_CODE_SHELL");
  });

  it("passes the JSON schema only when the Stage asks for structured output", async () => {
    await runner(execution({ stdout: SUCCESS })).run(request());
    expect(calls[0]?.args).not.toContain("--json-schema");

    await runner(execution({ stdout: SUCCESS })).run(
      request({ stage: "verify", jsonSchema: { type: "object" } }),
    );
    const args = calls[1]?.args ?? [];
    expect(args[args.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
  });

  it("reports the exact command line a human could paste", async () => {
    const result = await runner(execution({ stdout: SUCCESS })).run(request());

    expect(result.commandLine).toMatch(
      /^TICKET_RUNNER_STAGE=implement TICKET_RUNNER_SESSION=[0-9a-f-]{36} CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 CLAUDE_CODE_SHELL=\/bin\/bash claude --print/,
    );
    expect(result.commandLine).toContain("'/mattpocock-skills:implement https://example.com/issues/2'");
  });
});

describe("saved logs", () => {
  it("writes the command line, stdout, stderr and transcript for the Stage", async () => {
    await runner(execution({ stdout: SUCCESS, stderr: "a warning\n" })).run(request());

    expect(readdirSync(logDir).sort()).toEqual([
      "implement.command",
      "implement.stderr",
      "implement.stdout",
      "implement.transcript.jsonl",
    ]);
    expect(readFileSync(join(logDir, "implement.command"), "utf8")).toContain("claude --print");
    expect(readFileSync(join(logDir, "implement.stderr"), "utf8")).toBe("a warning\n");
    expect(readFileSync(join(logDir, "implement.stdout"), "utf8")).toBe(SUCCESS);
  });

  it("keeps only the JSON events in the transcript", async () => {
    const noise = `not json\n${SUCCESS}`;
    const result = await runner(execution({ stdout: noise })).run(request());

    const lines = readFileSync(result.transcriptPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ type: "system" });
  });
});

describe("logs written while the Stage runs", () => {
  /** Runs a Stage whose child prints, then looks at the disk before it exits. */
  function inspectMidRun(inspect: () => void) {
    const printed = execution({ stdout: SUCCESS, stderr: WARNING });
    return new ClaudeAgentRunner({
      run: async (_command, _args, options) => {
        options.onStdout?.(printed.stdout);
        options.onStderr?.(printed.stderr);
        inspect();
        return printed;
      },
    });
  }

  it("has the command line on disk before the child is spawned", async () => {
    let onDisk: string | undefined;

    await inspectMidRun(() => {
      onDisk = readFileSync(stageFile("command"), "utf8");
    }).run(request());

    expect(onDisk).toContain("claude --print");
  });

  it("appends stdout and stderr as the child prints them, not after it exits", async () => {
    let stdout: string | undefined;
    let stderr: string | undefined;

    await inspectMidRun(() => {
      stdout = readFileSync(stageFile("stdout"), "utf8");
      stderr = readFileSync(stageFile("stderr"), "utf8");
    }).run(request());

    expect(stdout).toBe(SUCCESS);
    expect(stderr).toBe(WARNING);
  });

  it("starts each Stage from empty files rather than an earlier Stage's output", async () => {
    await runner(execution({ stdout: SUCCESS, stderr: "first\n" })).run(request());
    await runner(execution({ stdout: SUCCESS, stderr: "second\n" })).run(request());

    expect(readFileSync(stageFile("stderr"), "utf8")).toBe("second\n");
    expect(readFileSync(stageFile("stdout"), "utf8")).toBe(SUCCESS);
  });

  it("recovers the whole output when a chunk could not be written", async () => {
    const interrupted = new ClaudeAgentRunner({
      run: async (_command, _args, options) => {
        // Clearing the run directory mid-Stage is enough to break an append.
        rmSync(logDir, { recursive: true, force: true });
        options.onStdout?.(SUCCESS);
        mkdirSync(logDir, { recursive: true });
        return execution({ stdout: SUCCESS });
      },
    });

    const result = await interrupted.run(request());

    expect(result.ok).toBe(true);
    expect(readFileSync(stageFile("stdout"), "utf8")).toBe(SUCCESS);
  });
});

/**
 * A session that spawns a background agent ends its main turn with a `result`
 * event, then wakes once per finished agent and ends each waking with another
 * `result` event that counts only its own waking. A waking usually carries no
 * structured output, and carries a fresh answer when the session answers again.
 */
describe("a session that woke for a background agent", () => {
  const mainTurn = {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 54,
    duration_ms: 421_549,
    structured_output: { notes: [{ summary: "the glossary drifts" }] },
    result: '{"notes":[{"note":"the glossary drifts"}]}',
  };
  const waking = (text: string) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 3,
    duration_ms: 45_172,
    result: text,
  });
  /** A waking that answers the schema again, as a session does after a review. */
  const answer = (notes: unknown[]) => ({
    ...waking(JSON.stringify({ notes })),
    structured_output: { notes },
  });
  const WOKEN_TWICE = transcript(
    mainTurn,
    { type: "assistant", message: { content: [{ type: "text", text: "one review is in" }] } },
    waking("one review is in"),
    { type: "assistant", message: { content: [{ type: "text", text: "both are in" }] } },
    waking("both are in"),
  );

  it("counts the turns of every waking, not the last one's", async () => {
    const result = await runner(execution({ stdout: WOKEN_TWICE })).run(request());

    expect(result.turns).toBe(60);
  });

  it("keeps the structured output the main turn returned", async () => {
    const result = await runner(execution({ stdout: WOKEN_TWICE })).run(
      request({ jsonSchema: { type: "object" }, resultRequired: false }),
    );

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ notes: [{ summary: "the glossary drifts" }] });
  });

  it("keeps a later answer over an earlier one", async () => {
    const stdout = transcript(
      answer([]),
      waking("one review is in"),
      answer([{ summary: "the review found a drift" }]),
    );

    const result = await runner(execution({ stdout })).run(
      request({ jsonSchema: { type: "object" }, resultRequired: false }),
    );

    expect(result.result).toEqual({ notes: [{ summary: "the review found a drift" }] });
  });

  it("keeps the latest answer when the last waking carries none", async () => {
    const stdout = transcript(
      answer([]),
      answer([{ summary: "the review found a drift" }]),
      waking("both are in"),
    );

    const result = await runner(execution({ stdout })).run(
      request({ jsonSchema: { type: "object" }, resultRequired: false }),
    );

    expect(result.result).toEqual({ notes: [{ summary: "the review found a drift" }] });
  });

  it("fails a Stage that needed an answer when no waking gave one", async () => {
    const stdout = transcript(waking("working on it"), waking("one review is in"));

    const result = await runner(execution({ stdout })).run(
      request({ stage: "verify", jsonSchema: { type: "object" } }),
    );

    expect(result).toMatchObject({ ok: false, failure: "invalid-result" });
    expect(result.result).toBeUndefined();
  });

  it("still fails a Stage whose last waking hit the turn cap", async () => {
    const stdout = transcript(mainTurn, {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      num_turns: 3,
    });

    const result = await runner(execution({ stdout })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "turn-capped" });
  });
});

describe("reading the outcome", () => {
  it("reports success with the turn count the session used", async () => {
    const result = await runner(execution({ stdout: SUCCESS })).run(request());

    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.turns).toBe(12);
  });

  it("returns the structured output when a schema was requested", async () => {
    const stdout = transcript({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 4,
      structured_output: { criteria: [], pass: true },
    });

    const result = await runner(execution({ stdout })).run(
      request({ stage: "verify", jsonSchema: { type: "object" } }),
    );

    expect(result.result).toEqual({ criteria: [], pass: true });
  });

  it("parses structured output the session emitted as a JSON string", async () => {
    const stdout = transcript({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 4,
      result: '```json\n{"criteria":[],"pass":false}\n```',
    });

    const result = await runner(execution({ stdout })).run(
      request({ stage: "verify", jsonSchema: { type: "object" } }),
    );

    expect(result.result).toEqual({ criteria: [], pass: false });
  });

  it("fails a Stage that promised structured output and returned prose", async () => {
    const stdout = transcript({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 4,
      result: "I could not decide",
    });

    const result = await runner(execution({ stdout })).run(
      request({ stage: "verify", jsonSchema: { type: "object" } }),
    );

    expect(result).toMatchObject({ ok: false, failure: "invalid-result" });
  });

  it("passes a Stage whose schema was only ever a side channel", async () => {
    const stdout = transcript({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 4,
      result: "I implemented it and noticed nothing",
    });

    const result = await runner(execution({ stdout })).run(
      request({
        stage: "implement",
        jsonSchema: { type: "object" },
        resultRequired: false,
      }),
    );

    expect(result).toMatchObject({ ok: true });
    expect(result.failure).toBeUndefined();
  });

  it("measures the Stage on its own clock rather than the session's", async () => {
    const stdout = transcript({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 12,
      duration_ms: 99_000_000,
    });

    const result = await runner(execution({ stdout })).run(request());

    expect(result.durationMs).toBeLessThan(60_000);
  });

  it("classifies a wall-clock kill as a timeout", async () => {
    const result = await runner(execution({ exitCode: 124, timedOut: true })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "timed-out" });
  });

  it("classifies a kill the child beat to its own exit code", async () => {
    const result = await runner(execution({ exitCode: 143, timedOut: true })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "timed-out" });
  });

  it("does not mistake a session that exited 124 on its own for a Stage past its limit", async () => {
    const result = await runner(execution({ exitCode: 124 })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "nonzero-exit" });
  });

  it("classifies the turn cap from the result event", async () => {
    const stdout = transcript({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      num_turns: 300,
    });

    const result = await runner(execution({ exitCode: 1, stdout })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "turn-capped" });
  });

  it("classifies a subscription rate limit so the failure is not blamed on the Ticket", async () => {
    const stdout = transcript({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "Claude AI usage limit reached|1748000000",
    });

    const result = await runner(execution({ exitCode: 1, stdout })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "rate-limited" });
  });

  it("classifies the session limit from the 429 on the result event, however it is worded", async () => {
    // What the CLI prints once the subscription's five-hour window is spent:
    // `subtype` still says success, and the message no longer says "usage".
    const stdout = transcript(
      { type: "system", subtype: "init", session_id: "abc" },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 429,
        num_turns: 1,
        result: "You've hit your session limit · resets 2:40am (Asia/Seoul)",
      },
    );

    const result = await runner(execution({ exitCode: 1, stdout })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "rate-limited" });
  });

  it("classifies a rejected rate_limit_event when the result event says nothing of it", async () => {
    const stdout = transcript(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1789839600, rateLimitType: "five_hour" },
      },
      { type: "result", subtype: "error", is_error: true, result: "The request was refused." },
    );

    const result = await runner(execution({ exitCode: 1, stdout })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "rate-limited" });
  });

  it("does not mistake a session that was only warned about the limit for one it stopped", async () => {
    const stdout = transcript(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning", utilization: 0.9, rateLimitType: "five_hour" },
      },
      { type: "result", subtype: "error", is_error: true, result: "The tests did not compile." },
    );

    const result = await runner(execution({ exitCode: 1, stdout })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "nonzero-exit" });
  });

  it("does not mistake a successful session that talks about rate limits for a rate limit", async () => {
    const stdout = transcript({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 85,
      result: "Implemented the rate-limited release path; the rate limit is now handled.",
    });

    const result = await runner(execution({ stdout })).run(request());

    expect(result).toMatchObject({ ok: true });
    expect(result.failure).toBeUndefined();
  });

  it("reads the rate limit from stderr when the session died without a result", async () => {
    const result = await runner(failedExecution("Claude AI usage limit reached")).run(
      request(),
    );

    expect(result).toMatchObject({ ok: false, failure: "rate-limited" });
  });

  it("says when the limit resets, from the rate_limit_event that rejected the request", async () => {
    const stdout = transcript(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning", resetsAt: 1789800000 },
      },
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1789839600, rateLimitType: "five_hour" },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 429,
        result: "You've hit your session limit · resets 2:40am (Asia/Seoul)",
      },
    );

    const result = await runner(execution({ exitCode: 1, stdout })).run(request());

    expect(result).toMatchObject({
      ok: false,
      failure: "rate-limited",
      limitResetsAt: "2026-09-19T17:40:00.000Z",
    });
  });

  it("names no reset time when no rejecting event carried one", async () => {
    const stdout = transcript(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning", resetsAt: 1789800000 },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 429,
        result: "You've hit your session limit",
      },
    );

    const result = await runner(execution({ exitCode: 1, stdout })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "rate-limited" });
    expect(result.limitResetsAt).toBeUndefined();
  });

  it("classifies an API error with a 5xx status as a transient API failure", async () => {
    // What the CLI prints once it has given up retrying an overloaded API.
    const stdout = transcript({
      type: "result",
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 529,
      num_turns: 41,
      result: "API Error: 529 Overloaded. This is a server-side issue, usually temporary.",
    });

    const result = await runner(execution({ exitCode: 1, stdout })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "api-error" });
  });

  it("classifies an API error with no status as a transient API failure", async () => {
    const stdout = transcript({
      type: "result",
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: null,
      result: "API Error: No response from API (waited 3m, then 10m on the retry).",
    });

    const result = await runner(execution({ exitCode: 1, stdout })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "api-error" });
  });

  it("leaves an API error with a 4xx status other than 429 a non-zero exit", async () => {
    const stdout = transcript({
      type: "result",
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 400,
      result: "API Error: 400 The prompt is too long.",
    });

    const result = await runner(execution({ exitCode: 1, stdout })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "nonzero-exit" });
  });

  it("leaves a session that failed for another reason a non-zero exit, whatever its status", async () => {
    const stdout = transcript({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      api_error_status: 503,
      result: "The tests did not compile.",
    });

    const result = await runner(execution({ exitCode: 1, stdout })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "nonzero-exit" });
  });

  it("leaves a trace and fails when the session could not be started at all", async () => {
    const broken = new ClaudeAgentRunner({
      run: async () => {
        throw new Error("spawn claude ENOENT");
      },
    });

    const result = await broken.run(request());

    expect(result).toMatchObject({ ok: false, failure: "nonzero-exit" });
    expect(readFileSync(join(logDir, "implement.stderr"), "utf8")).toContain(
      "spawn claude ENOENT",
    );
    expect(readFileSync(join(logDir, "implement.command"), "utf8")).toContain("claude --print");
  });

  it("falls back to a non-zero exit when nothing more specific is known", async () => {
    const result = await runner(failedExecution("boom", { exitCode: 2 })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "nonzero-exit" });
  });
});
