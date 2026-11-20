// WebSocket message contracts between clients (display + control) and server.

import type { Config } from "./config.js";
import type { Aircraft } from "./aircraft.js";
import type { DataSource } from "./config.js";

export interface SourceStatus {
  source: DataSource;
  /** Whether the most recent poll succeeded. */
  ok: boolean;
  /** Number of aircraft in the last snapshot. */
  count: number;
  /** Last successful poll (ms epoch), or null. */
  lastOk: number | null;
  /** Human-readable note (e.g. last error). */
  message?: string;
  /** What the sky is showing: fresh data, a held last snapshot, a labelled
   *  replay of earlier recorded traffic, or nothing at all. */
  mode?: FeedMode;
  /** During replay: when (ms epoch) the frame being shown was recorded. */
  replayOf?: number;
}

export type FeedMode = "live" | "stale" | "replay" | "unavailable";

/** Server -> client. */
export type ServerMessage =
  | { type: "config"; config: Config }
  | { type: "aircraft"; now: number; aircraft: Aircraft[] }
  | { type: "status"; status: SourceStatus };

/** Client -> server. */
export type ClientMessage =
  | { type: "hello"; role: "display" | "control" }
  | { type: "patchConfig"; patch: Partial<Config> }
  | { type: "setConfig"; config: Config }
  | { type: "resetConfig" };
