import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";

/**
 * Which kind of Host a Run executes on (CONTEXT.md), decided here and nowhere
 * else, so every part of the pipeline that behaves differently in the cloud
 * asks the same question the same way.
 */

/** A workstation that outlives the Run, or a Claude Code cloud session's VM. */
export type HostKind = "workstation" | "cloud";

/** What a Claude Code cloud session sets, to `true`, in every process it starts. */
export const CLOUD_ENV_VAR = "CLAUDE_CODE_REMOTE";

/**
 * The Host the environment says this process runs on.
 *
 * Takes the environment so either answer can be tested without `process.env`.
 * Only the value the cloud session sets counts: anything else, the variable
 * unset included, is a workstation, which is what every Host was before
 * ADR-0008.
 */
export function hostKind(env: Record<string, string | undefined>): HostKind {
  return env[CLOUD_ENV_VAR] === "true" ? "cloud" : "workstation";
}

/**
 * The Host a Run executes on, as the Run lock records it: which kind, which
 * one, and what a human calls it.
 *
 * `id` is what two Hosts are told apart by, and it is stable for as long as the
 * Host exists: a workstation's machine, which outlives every Run on it, and a
 * cloud Host's session, which never repeats. Only a Run on the same Host can
 * tell whether the process a lock names is still running, so this is the
 * question the lock asks before it looks at a process at all.
 */
export interface Host {
  kind: HostKind;
  id: string;
  /** The machine's hostname, for a human; never compared. */
  name: string;
}

/** How the machine a process runs on answers for itself. Seams for tests. */
export interface MachineProbe {
  hostname: () => string;
  /** The operating system's own id for the machine, when it keeps one. */
  machineId: () => string | undefined;
}

/**
 * What a cloud session is known by, in the order they are asked: the cloud's
 * own name for the session, and then the session the Run's process was started
 * from, which on a cloud Host is the Operator's and lives as long as the VM.
 */
const SESSION_ENV_VARS = ["CLAUDE_CODE_REMOTE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

/**
 * The Host this process runs on.
 *
 * A cloud Host that names no session is given an id no other process will
 * ever have, rather than the machine's: VMs made from one image can share a
 * machine id and a hostname, and a second session taken for the first would
 * find the first's pid missing and take a live Run's lock over. The cost is
 * that a Run there is a stranger even to its own Host, so its lock is always
 * one a human releases.
 */
export function currentHost(
  env: Record<string, string | undefined>,
  machine: MachineProbe = { hostname, machineId: readMachineId },
): Host {
  const kind = hostKind(env);
  const name = machine.hostname();
  const session = SESSION_ENV_VARS.map((variable) => env[variable]).find((value) => value);
  if (kind === "cloud") return { kind, id: session ?? `unnamed-${randomUUID()}`, name };
  return { kind, id: machine.machineId() ?? name, name };
}

/** Whether two Hosts are the same one, which only then can see each other's processes. */
export function sameHost(a: Host, b: Host): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** A Host as a sentence names it. */
export function describeHost(host: Host): string {
  return host.kind === "cloud"
    ? `the cloud Host of session \`${host.id}\``
    : `the workstation \`${host.name}\``;
}

/**
 * The id the operating system keeps for the machine: systemd's on Linux, the
 * platform UUID on macOS. Undefined where there is none to read, and the
 * hostname stands in.
 */
function readMachineId(): string | undefined {
  try {
    if (process.platform === "darwin") {
      const output = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8",
      });
      return /"IOPlatformUUID" = "([^"]+)"/.exec(output)?.[1];
    }
    for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      if (!existsSync(path)) continue;
      const id = readFileSync(path, "utf8").trim();
      if (id !== "") return id;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
