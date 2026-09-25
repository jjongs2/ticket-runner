import { describe, expect, it } from "vitest";
import { CLOUD_ENV_VAR, currentHost, describeHost, hostKind, sameHost } from "./host.js";

describe("hostKind", () => {
  it("calls a Claude Code cloud session a cloud Host", () => {
    expect(hostKind({ [CLOUD_ENV_VAR]: "true" })).toBe("cloud");
  });

  it("calls anything else a workstation", () => {
    expect(hostKind({})).toBe("workstation");
    expect(hostKind({ [CLOUD_ENV_VAR]: "false" })).toBe("workstation");
    expect(hostKind({ [CLOUD_ENV_VAR]: "" })).toBe("workstation");
  });
});

describe("currentHost", () => {
  const machine = { hostname: () => "desk", machineId: () => "4f1c0ffee" };

  it("names a workstation by its machine, whatever session started the Run", () => {
    const host = currentHost({ CLAUDE_CODE_SESSION_ID: "session-a" }, machine);

    expect(host).toEqual({ kind: "workstation", id: "4f1c0ffee", name: "desk" });
    expect(currentHost({ CLAUDE_CODE_SESSION_ID: "session-b" }, machine)).toEqual(host);
  });

  it("names a workstation by its hostname when it has no machine id to read", () => {
    const host = currentHost({}, { hostname: () => "desk", machineId: () => undefined });

    expect(host).toEqual({ kind: "workstation", id: "desk", name: "desk" });
  });

  it("names a cloud Host by its session, never by the machine", () => {
    const host = currentHost(
      { [CLOUD_ENV_VAR]: "true", CLAUDE_CODE_REMOTE_SESSION_ID: "session_01abc" },
      machine,
    );

    expect(host).toEqual({ kind: "cloud", id: "session_01abc", name: "desk" });
  });

  it("falls back to the session a cloud Host's process was started from", () => {
    const host = currentHost(
      { [CLOUD_ENV_VAR]: "true", CLAUDE_CODE_SESSION_ID: "session-a" },
      machine,
    );

    expect(host.id).toBe("session-a");
  });

  it("never names a cloud Host that names no session by its machine", () => {
    // VMs made from one image can share both, and a session taken for another
    // would take a live Run's lock over.
    const first = currentHost({ [CLOUD_ENV_VAR]: "true" }, machine);
    const second = currentHost({ [CLOUD_ENV_VAR]: "true" }, machine);

    expect(first.kind).toBe("cloud");
    expect(first.id).not.toBe("4f1c0ffee");
    expect(first.id).not.toBe("desk");
    expect(second.id).not.toBe(first.id);
  });

  it("reads the real machine when no seam is given", () => {
    const host = currentHost({});

    expect(host.kind).toBe("workstation");
    expect(host.id).not.toBe("");
    expect(host.name).not.toBe("");
  });
});

describe("describeHost", () => {
  it("names a workstation by its hostname, and a cloud Host by its session", () => {
    expect(describeHost({ kind: "workstation", id: "4f1c0ffee", name: "desk" })).toBe(
      "the workstation `desk`",
    );
    expect(describeHost({ kind: "cloud", id: "session_01abc", name: "runsc" })).toBe(
      "the cloud Host of session `session_01abc`",
    );
  });
});

describe("sameHost", () => {
  const desk = { kind: "workstation" as const, id: "4f1c0ffee", name: "desk" };

  it("is the same Host by kind and id, whatever it is called", () => {
    expect(sameHost(desk, { ...desk, name: "renamed" })).toBe(true);
  });

  it("is another Host by id, or by kind", () => {
    expect(sameHost(desk, { ...desk, id: "another-machine" })).toBe(false);
    expect(sameHost(desk, { ...desk, kind: "cloud" })).toBe(false);
  });
});
