import { v, type Infer } from "convex/values";

/**
 * Connection settings for the Daytona API. Components are isolated from the
 * host app's environment variables, so the host-side client (`src/client`)
 * resolves credentials (from options or `process.env`) and passes them into
 * every component action — the same pattern used by other Convex components
 * that wrap external APIs.
 */
export const configValidator = v.object({
  /** Daytona API key (create one at https://app.daytona.io/dashboard/keys). */
  apiKey: v.string(),
  /** API base URL. Defaults to Daytona Cloud (`https://app.daytona.io/api`). */
  apiUrl: v.optional(v.string()),
});

export type DaytonaConfig = Infer<typeof configValidator>;

export const DEFAULT_API_URL = "https://app.daytona.io/api";

/** Mirrors the Daytona API SandboxState enum (wire values, api-client v0.214). */
export type SandboxState =
  | "creating"
  | "restoring"
  | "starting"
  | "started"
  | "stopping"
  | "stopped"
  | "pausing"
  | "paused"
  | "resuming"
  | "archiving"
  | "archived"
  | "destroying"
  | "destroyed"
  | "resizing"
  | "snapshotting"
  | "forking"
  | "pulling_snapshot"
  | "building_snapshot"
  | "pending_build"
  | "build_failed"
  | "error"
  | "unknown";

export interface ApiSandbox {
  id: string;
  name?: string;
  state: SandboxState;
  target?: string;
  snapshot?: string;
  labels?: Record<string, string>;
  public?: boolean;
  toolboxProxyUrl?: string;
  errorReason?: string;
  [k: string]: unknown;
}

export interface CreateSandboxRequest {
  name?: string;
  snapshot?: string;
  buildInfo?: { dockerfileContent: string };
  user?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  public?: boolean;
  target?: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  autoStopInterval?: number;
  autoArchiveInterval?: number;
  autoDeleteInterval?: number;
}

export interface ProcessExecutionResponse {
  exitCode: number;
  result: string;
  artifacts?: {
    stdout?: string;
    charts?: Array<Record<string, unknown>>;
  };
}

export interface FileInfo {
  name: string;
  isDir: boolean;
  size?: number;
  modTime?: string;
  mode?: string;
  permissions?: string;
  owner?: string;
  group?: string;
  [k: string]: unknown;
}

export interface PreviewUrlResponse {
  url: string;
  token?: string;
  port: number;
  [k: string]: unknown;
}

/** Cap stored execution output so documents stay far below Convex's 1 MiB doc limit. */
export const MAX_STORED_OUTPUT = 64_000;
/** Cap stored command/code input. */
export const MAX_STORED_INPUT = 4_000;
/** Cap output returned across the Convex function boundary (limit is 16 MiB total). */
export const MAX_RETURNED_OUTPUT = 4_000_000;

/** Clamp caller-provided limits to a sane integer range for `.take()`. */
export function clampLimit(limit: number | undefined, fallback: number): number {
  const floored = Math.floor(limit ?? fallback);
  if (!Number.isFinite(floored)) return fallback;
  return Math.min(Math.max(floored, 1), 500);
}

const TRUNCATION_MARKER = "\n…[truncated]";

/** Truncate to a HARD bound of `max` characters, marker included. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}
