import { describe, expect, it } from "vitest";
import { throwOnFailure } from "./adapters/exec.js";
import { OutsideFault, faultSide, firstLine } from "./outside-fault.js";
import { failedExecution } from "./testing/executions.js";

describe("whose fault a failed command is", () => {
  it.each([
    "gh: Bad Gateway (HTTP 502)",
    "gh: Server Error (HTTP 500)",
    "HTTP 503: Service Unavailable (https://api.github.com/repos/acme/repo)",
    "unexpected end of JSON input",
    "invalid character '<' looking for beginning of value",
  ])("reads `gh` printing %s as GitHub's", (output) => {
    expect(faultSide("gh", output)).toBe("github");
  });

  it.each([
    "gh: Not Found (HTTP 404)",
    "gh: Validation Failed (HTTP 422)",
    "gh: Bad credentials (HTTP 401)",
    "gh: Resource not accessible by integration (HTTP 403)",
  ])("reads `gh` printing %s as no fault outside the Ticket", (output) => {
    expect(faultSide("gh", output)).toBeUndefined();
  });

  it.each([
    "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    "ssh: Could not resolve hostname github.com: Name or service not known",
    "fatal: unable to access 'https://github.com/acme/repo/': Could not resolve host: github.com",
    "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/repo/'",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "ssh: connect to host github.com port 22: Connection refused",
    "ssh: connect to host github.com port 22: Connection timed out",
    "fatal: unable to access 'https://github.com/acme/repo/': Failed to connect to github.com port 443",
    "fatal: unable to access 'https://github.com/acme/repo/': The requested URL returned error: 502",
    "error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503",
  ])("reads git printing %s as the remote's", (output) => {
    expect(faultSide("git", output)).toBe("remote");
  });

  it.each([
    "fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
    "fatal: 'origin' does not appear to be a git repository",
    " ! [rejected]        main       -> main  (non-fast-forward)",
    "error: cannot pull with rebase: You have unstaged changes.",
    "fatal: Not possible to fast-forward, aborting.",
  ])("reads git printing %s as no fault outside the Ticket", (output) => {
    expect(faultSide("git", output)).toBeUndefined();
  });

  it("reads the words only from the command that speaks for that side", () => {
    expect(faultSide("git", "gh: Bad Gateway (HTTP 502)")).toBeUndefined();
    expect(faultSide("gh", "Permission denied (publickey)")).toBeUndefined();
    expect(faultSide("npm test", "Connection refused")).toBeUndefined();
  });
});

describe("a failed command's error", () => {
  it("is an OutsideFault naming the command and the first line it printed", () => {
    const failing = () =>
      throwOnFailure(
        "git",
        ["pull", "--ff-only", "origin", "main"],
        failedExecution("\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n"),
      );

    expect(failing).toThrow(OutsideFault);
    try {
      failing();
    } catch (error) {
      expect(error).toMatchObject({
        side: "remote",
        command: "git pull --ff-only origin main",
        line: "git@github.com: Permission denied (publickey).",
      });
      expect((error as Error).message).toMatch(/^`git pull --ff-only origin main` exited 1\n/);
    }
  });

  it("stays a plain error for any other failure", () => {
    const failing = () =>
      throwOnFailure("git", ["pull", "--ff-only", "origin", "main"], failedExecution("fatal: Not possible to fast-forward, aborting."));

    expect(failing).toThrow(/exited 1/);
    expect(failing).not.toThrow(OutsideFault);
  });
});

describe("firstLine", () => {
  it("skips blank lines and trims", () => {
    expect(firstLine("\n\n  first  \nsecond")).toBe("first");
    expect(firstLine("")).toBe("");
  });
});
