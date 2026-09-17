import { describe, expect, it } from "vitest";
import {
  SELF_HOSTING_GUIDANCE,
  fixPrompt,
  implementPrompt,
  verifyPrompt,
} from "./prompts.js";

const url = "https://github.com/jjongs2/agent-pipeline/issues/2";

const FAILED_CHECK = {
  kind: "failed-check" as const,
  summary: "Check `npm test` failed",
  evidence: "FAIL src/a.test.ts",
};

describe("implementPrompt", () => {
  it("begins with the skill invocation and the full issue URL", () => {
    expect(implementPrompt(url, "").split("\n")[0]).toBe(
      `/mattpocock-skills:implement ${url}`,
    );
  });

  it("carries the correction guidance for a known plugin defect", () => {
    const prompt = implementPrompt(url, "");

    expect(prompt).toMatch(/confirm the ticket title/i);
    expect(prompt).toMatch(/commit .*before .*code-review/i);
    expect(prompt).toMatch(/first commit's subject becomes the pull request title/i);
    expect(prompt).toMatch(/summarise the whole Ticket/i);
    expect(prompt).toMatch(/nested review agents|additional review agents/i);
    expect(prompt).toMatch(/do not open pull requests/i);
    expect(prompt).toMatch(/do not close/i);
  });

  it("appends the configured extra prompt after the guidance", () => {
    const prompt = implementPrompt(url, "Prefer table-driven tests.");

    expect(prompt.trimEnd().endsWith("Prefer table-driven tests.")).toBe(true);
  });

  it("leaves no trailing blank block when no extra prompt is configured", () => {
    expect(implementPrompt(url, "")).toBe(implementPrompt(url, "   "));
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
    expect(fixPrompt(url, FAILED_CHECK, "")).not.toContain("/mattpocock-skills:");
  });

  it("names the Ticket, the failure and the evidence that was captured", () => {
    const prompt = fixPrompt(url, FAILED_CHECK, "");

    expect(prompt).toContain(url);
    expect(prompt).toContain("Check `npm test` failed");
    expect(prompt).toContain("FAIL src/a.test.ts");
  });

  it("says which of the three kinds of failure this is", () => {
    expect(fixPrompt(url, FAILED_CHECK, "")).toMatch(/a Check .*failed/i);
    expect(fixPrompt(url, { ...FAILED_CHECK, kind: "unmet-criteria" }, "")).toMatch(
      /unmet Acceptance Criteria/i,
    );
    expect(fixPrompt(url, { ...FAILED_CHECK, kind: "failed-ci" }, "")).toMatch(
      /pull request check failed/i,
    );
  });

  it("asks for the regression test a gap the Verdict found should have had", () => {
    expect(fixPrompt(url, { ...FAILED_CHECK, kind: "unmet-criteria" }, "")).toMatch(
      /regression test/i,
    );
  });

  it("tells the session to commit where it is and to open nothing", () => {
    const prompt = fixPrompt(url, FAILED_CHECK, "");

    expect(prompt).toMatch(/commit .*on the .*branch|branch you are on/i);
    expect(prompt).toMatch(/do not open pull requests/i);
  });

  it("appends the configured extra prompt", () => {
    expect(fixPrompt(url, FAILED_CHECK, "Keep it small.").trimEnd().endsWith("Keep it small.")).toBe(
      true,
    );
  });
});

describe("the self-hosting guidance", () => {
  it("tells the session to exercise the pipeline through its tests and fakes only", () => {
    expect(SELF_HOSTING_GUIDANCE).toMatch(/tests? and fakes/i);
    expect(SELF_HOSTING_GUIDANCE).toMatch(/never run .*against this repository/is);
    expect(SELF_HOSTING_GUIDANCE).toMatch(/never kill .*process/is);
  });

  it("is carried verbatim by every Stage prompt, from one place", () => {
    expect(implementPrompt(url, "")).toContain(SELF_HOSTING_GUIDANCE);
    expect(verifyPrompt(url, "")).toContain(SELF_HOSTING_GUIDANCE);
    expect(fixPrompt(url, FAILED_CHECK, "")).toContain(SELF_HOSTING_GUIDANCE);
  });

  it("stays ahead of the repo's own extra prompt", () => {
    const prompt = implementPrompt(url, "Prefer table-driven tests.");

    expect(prompt.indexOf(SELF_HOSTING_GUIDANCE)).toBeLessThan(
      prompt.indexOf("Prefer table-driven tests."),
    );
  });
});
