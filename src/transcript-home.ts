import type { Config } from "./config.js";
import type { HostKind } from "./host.js";
import type { Tracker } from "./ports/tracker.js";

/**
 * Where a Run keeps a handed-off Ticket's transcripts: on the Target's remote,
 * beside the Ticket's state (ADR-0004), or on the Host the Run executes on,
 * which a workstation outlives and a cloud Host's VM does not.
 */
export type TranscriptHome = "remote" | HostKind;

export interface ResolvedTranscriptHome {
  home: TranscriptHome;
  /** The one line the Run says when the Target's visibility could not be read. */
  said?: string;
}

/**
 * Where this Run keeps a handed-off Ticket's transcripts, decided once before
 * the first Ticket.
 *
 * The config's `keepTranscripts` wins where it is set. Unset, the Target's
 * visibility answers: a transcript holds whatever the Host could see, and on
 * a public Target the state branch is public and a pushed commit stays
 * reachable by its SHA, so it stays off the remote there (ADR-0004). A Target
 * whose visibility cannot be read counts as public, and the Run says so.
 */
export async function resolveTranscriptHome({
  config,
  tracker,
  host,
}: {
  config: Pick<Config, "keepTranscripts">;
  tracker: Pick<Tracker, "visibility">;
  host: HostKind;
}): Promise<ResolvedTranscriptHome> {
  if (config.keepTranscripts !== undefined) {
    return { home: config.keepTranscripts ? "remote" : host };
  }
  const visibility = await tracker.visibility();
  if (visibility === "private") return { home: "remote" };
  if (visibility === "public") return { home: host };
  return {
    home: host,
    said:
      "could not read whether the Target is public, so it counts as public: " +
      "a handed-off Ticket's transcripts stay on this Host",
  };
}
