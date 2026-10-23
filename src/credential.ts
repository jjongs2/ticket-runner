import type { HostKind } from "./host.js";

/**
 * Whose money a Run's Stages spend, decided once when the Run starts and held
 * for the whole Run: the subscription the Host is logged in with, or the API
 * key the Host exports, which a Run uses only when it was started with
 * `--api-key`. The choice is the Host's business, so it is a flag and never a
 * field of the Target's config.
 */
export type Credential = "subscription" | "api-key";

/**
 * The variable the CLI reads an API key from. Under `-p` it outranks the
 * subscription login without asking, so a Stage of a subscription Run is
 * started without it, whatever the Host exports.
 */
export const API_KEY_ENV_VAR = "ANTHROPIC_API_KEY";

/** The credential, as the Run summary's header and the log name it. */
export const CREDENTIAL_WORDS: Record<Credential, string> = {
  subscription: "subscription",
  "api-key": "API key",
};

/**
 * The `apiKeySource` a Stage's `system/init` event reports when it ran on the
 * Run's credential. Any other is a Stage billed somewhere the Run did not
 * choose: a key an `apiKeyHelper` in the Host's settings supplied, say, which
 * no environment variable removes.
 */
export function expectedKeySource(credential: Credential): string {
  return credential === "api-key" ? API_KEY_ENV_VAR : "none";
}

/**
 * A Stage that reported another `apiKeySource` than its Run's credential
 * expects, which the Run's log and its summary each name.
 */
export interface StrayStage {
  ticket: number;
  stage: string;
  /** What the Stage's `system/init` event said it ran on. */
  apiKeySource: string;
}

/**
 * Why a Run on `credential` will not start on this Host, or nothing where it
 * can.
 *
 * Only an `--api-key` Run can be refused. A cloud Host always runs its
 * sessions on the subscription whatever its environment says, so the flag
 * would be a Run spending the subscription without a word; and a Host that
 * exports no key has none to hand the Stages.
 */
export function credentialRefusal(
  credential: Credential,
  host: HostKind,
  env: Record<string, string | undefined>,
): string | undefined {
  if (credential !== "api-key") return undefined;
  if (host === "cloud") {
    return (
      "`--api-key` needs a workstation Host: a cloud session runs every Stage on the " +
      `subscription, whatever \`${API_KEY_ENV_VAR}\` says. Run without \`--api-key\`, or ` +
      "start the Run on a workstation."
    );
  }
  if ((env[API_KEY_ENV_VAR] ?? "") === "") {
    return (
      `\`--api-key\` runs every Stage on the \`${API_KEY_ENV_VAR}\` this shell exports, and it ` +
      "exports none. Export the key, or run without `--api-key` to run on the subscription."
    );
  }
  return undefined;
}
