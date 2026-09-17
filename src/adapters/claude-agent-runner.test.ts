import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { StageRequest } from "../ports/agent-runner.js";
import { ClaudeAgentRunner } from "./claude-agent-runner.js";
import type { ExecOptions, Execution } from "./exec.js";

let logDir: string;
let calls: { command: string; args: string[]; options: ExecOptions }[];

function execution(overrides: Partial<Execution> = {}): Execution {
  return { exitCode: 0, stdout: "", stderr: "", output: "", ...overrides };
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

function runner(result: Execution | ((args: string[]) => Execution)) {
  return new ClaudeAgentRunner({
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return typeof result === "function" ? result(args) : result;
    },
  });
}

function request(overrides: Partial<StageRequest> = {}): StageRequest {
  return {
    stage: "implement",
    prompt: "/mattpocock-skills:implement https://example.com/issues/2",
    cwd: "/repo/.worktrees/ticket-2",
    model: "claude-opus-5",
    maxTurns: 300,
    maxMinutes: 60,
    permissionMode: "auto",
    logDir,
    ...overrides,
  };
}

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "agent-pipeline-logs-"));
  calls = [];
});

describe("the command line", () => {
  it("runs headless with the prompt, model, limits and permission settings", async () => {
    await runner(execution({ stdout: SUCCESS })).run(request());
    const args = calls[0]?.args ?? [];

    expect(calls[0]?.command).toBe("claude");
    expect(args).toContain("--print");
    expect(args).toContain("/mattpocock-skills:implement https://example.com/issues/2");
    expect(args.join(" ")).toContain("--permission-prompts none");
    expect(args.join(" ")).toContain("--permission-mode auto");
    expect(args.join(" ")).toContain("--model claude-opus-5");
    expect(args.join(" ")).toContain("--max-turns 300");
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

    expect(result.commandLine).toContain("claude --print");
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

  it("classifies a wall-clock kill as a timeout", async () => {
    const result = await runner(execution({ exitCode: 124, stdout: "" })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "timed-out" });
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
    const result = await runner(execution({ exitCode: 2, stderr: "boom" })).run(request());

    expect(result).toMatchObject({ ok: false, failure: "nonzero-exit" });
  });
});
