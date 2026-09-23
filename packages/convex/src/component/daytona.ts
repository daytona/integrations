/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal fetch-based Daytona REST client.
 *
 * Convex components run in Convex's default JavaScript runtime, which supports
 * `fetch` but not the Node.js APIs the full `@daytona/sdk` depends on (ws,
 * aws-sdk, tar, …) — and bundling that SDK would blow up component bundle size
 * and cold starts. So, like the official Convex components for other external
 * services, this wraps the Daytona REST + toolbox APIs directly. Endpoint and
 * payload shapes mirror `packages/n8n-nodes-daytona`.
 */

import {
  DEFAULT_API_URL,
  type ApiSandbox,
  type CreateSandboxRequest,
  type DaytonaConfig,
  type FileInfo,
  type PreviewUrlResponse,
  type ProcessExecutionResponse,
  type SandboxState,
} from "./types.js";

export class DaytonaApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DaytonaApiError";
  }
}

type Query = Record<string, string | number | boolean | undefined>;

const SANDBOX_READY_POLL = { intervalMs: 1000, timeoutMs: 60_000 };
/** Terminal failure states — polling for readiness bails out on these. */
const FAILURE_STATES: ReadonlySet<SandboxState> = new Set([
  "error",
  "build_failed",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DaytonaClient {
  private readonly baseUrl: string;
  /** toolboxProxyUrl per sandbox, cached for the lifetime of one action call. */
  private readonly toolboxBaseCache = new Map<string, string>();

  constructor(private readonly config: DaytonaConfig) {
    this.baseUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  }

  private headers(json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  private async request(
    url: string,
    method: string,
    body?: unknown,
    query?: Query,
  ): Promise<Response> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) params.set(key, String(value));
    }
    // `URLSearchParams.size` is not implemented in Convex's runtime — use toString().
    const encoded = params.toString();
    const qs = encoded ? `?${encoded}` : "";
    const isForm = body instanceof FormData;
    const response = await fetch(`${url}${qs}`, {
      method,
      headers: this.headers(body !== undefined && !isForm),
      body:
        body === undefined
          ? undefined
          : isForm
            ? body
            : JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new DaytonaApiError(
        `Daytona API ${method} ${url} failed with ${response.status}: ${detail.slice(0, 500)}`,
        response.status,
      );
    }
    return response;
  }

  private async api<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Query,
  ): Promise<T> {
    const response = await this.request(
      `${this.baseUrl}${path}`,
      method,
      body,
      query,
    );
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Toolbox endpoints hang off a per-sandbox proxy base:
   * `{toolboxProxyUrl}/{sandboxId}{path}`. The `toolboxProxyUrl` returned by
   * `GET /sandbox/{id}` already includes the `/toolbox` segment.
   */
  private async toolboxBase(sandboxId: string): Promise<string> {
    const cached = this.toolboxBaseCache.get(sandboxId);
    if (cached) return cached;
    const sandbox = await this.getSandbox(sandboxId);
    if (!sandbox.toolboxProxyUrl) {
      throw new DaytonaApiError(
        `Sandbox "${sandboxId}" has no toolboxProxyUrl (state: ${sandbox.state}). It may not be started yet.`,
      );
    }
    const base = sandbox.toolboxProxyUrl.replace(/\/+$/, "");
    this.toolboxBaseCache.set(sandboxId, base);
    return base;
  }

  private async toolbox(
    sandboxId: string,
    method: string,
    path: string,
    body?: unknown,
    query?: Query,
  ): Promise<Response> {
    const base = await this.toolboxBase(sandboxId);
    return await this.request(
      `${base}/${encodeURIComponent(sandboxId)}${path}`,
      method,
      body,
      query,
    );
  }

  // ---- Sandbox lifecycle ----

  async createSandbox(request: CreateSandboxRequest): Promise<ApiSandbox> {
    return await this.api<ApiSandbox>("POST", "/sandbox", request);
  }

  async getSandbox(sandboxId: string): Promise<ApiSandbox> {
    return await this.api<ApiSandbox>(
      "GET",
      `/sandbox/${encodeURIComponent(sandboxId)}`,
    );
  }

  async startSandbox(sandboxId: string): Promise<void> {
    await this.api("POST", `/sandbox/${encodeURIComponent(sandboxId)}/start`);
  }

  async stopSandbox(sandboxId: string): Promise<void> {
    await this.api("POST", `/sandbox/${encodeURIComponent(sandboxId)}/stop`);
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    await this.api("DELETE", `/sandbox/${encodeURIComponent(sandboxId)}`);
  }

  /** Poll until the sandbox reaches one of `targets`; throws on failure states. */
  async waitForState(
    sandboxId: string,
    targets: SandboxState[],
    options?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<ApiSandbox> {
    const targetSet = new Set(targets);
    const timeoutMs = options?.timeoutMs ?? SANDBOX_READY_POLL.timeoutMs;
    const intervalMs = options?.intervalMs ?? SANDBOX_READY_POLL.intervalMs;
    const startedAt = Date.now();
    let lastState: SandboxState = "unknown";
    while (Date.now() - startedAt <= timeoutMs) {
      const sandbox = await this.getSandbox(sandboxId);
      lastState = sandbox.state;
      if (targetSet.has(sandbox.state)) return sandbox;
      if (FAILURE_STATES.has(sandbox.state)) {
        throw new DaytonaApiError(
          `Sandbox "${sandboxId}" entered failure state "${sandbox.state}"${sandbox.errorReason ? `: ${sandbox.errorReason}` : ""}`,
        );
      }
      await sleep(intervalMs);
    }
    throw new DaytonaApiError(
      `Timed out after ${timeoutMs}ms waiting for sandbox "${sandboxId}" to reach [${targets.join(", ")}]. Last state: "${lastState}".`,
    );
  }

  /** Start a stopped/paused/archived sandbox and wait until it's running. No-op if started. */
  async ensureStarted(
    sandboxId: string,
    options?: { timeoutMs?: number },
  ): Promise<ApiSandbox> {
    const sandbox = await this.getSandbox(sandboxId);
    if (sandbox.state === "started") return sandbox;
    if (
      sandbox.state === "stopped" ||
      sandbox.state === "paused" ||
      sandbox.state === "archived"
    ) {
      await this.startSandbox(sandboxId);
    }
    return await this.waitForState(sandboxId, ["started"], options);
  }

  // ---- Process (toolbox) ----

  async execute(
    sandboxId: string,
    args: {
      command: string;
      cwd?: string;
      envs?: Record<string, string>;
      timeoutSeconds?: number;
    },
  ): Promise<ProcessExecutionResponse> {
    const response = await this.toolbox(sandboxId, "POST", "/process/execute", {
      command: args.command,
      cwd: args.cwd,
      envs: args.envs,
      timeout: args.timeoutSeconds,
    });
    return (await response.json()) as ProcessExecutionResponse;
  }

  async runCode(
    sandboxId: string,
    args: {
      code: string;
      language: string;
      argv?: string[];
      envs?: Record<string, string>;
      timeoutSeconds?: number;
    },
  ): Promise<ProcessExecutionResponse> {
    const response = await this.toolbox(
      sandboxId,
      "POST",
      "/process/code-run",
      {
        code: args.code,
        language: args.language,
        argv: args.argv,
        envs: args.envs,
        timeout: args.timeoutSeconds,
      },
    );
    return (await response.json()) as ProcessExecutionResponse;
  }

  // ---- Files (toolbox) ----

  async downloadFile(sandboxId: string, path: string): Promise<string> {
    const response = await this.toolbox(sandboxId, "GET", "/files/download", undefined, { path });
    return await response.text();
  }

  async uploadFile(
    sandboxId: string,
    path: string,
    content: string,
  ): Promise<void> {
    const form = new FormData();
    const filename = path.split("/").pop() || "upload";
    form.append(
      "file",
      new Blob([content], { type: "application/octet-stream" }),
      filename,
    );
    await this.toolbox(sandboxId, "POST", "/files/upload-v2", form, { path });
  }

  async listFiles(sandboxId: string, path: string): Promise<FileInfo[]> {
    const response = await this.toolbox(sandboxId, "GET", "/files", undefined, { path });
    const files = (await response.json()) as FileInfo[];
    return Array.isArray(files) ? files : [];
  }

  async deleteFile(
    sandboxId: string,
    path: string,
    recursive?: boolean,
  ): Promise<void> {
    await this.toolbox(sandboxId, "DELETE", "/files", undefined, {
      path,
      ...(recursive ? { recursive: true } : {}),
    });
  }

  // ---- Preview URLs ----

  async previewUrl(sandboxId: string, port: number): Promise<PreviewUrlResponse> {
    return await this.api<PreviewUrlResponse>(
      "GET",
      `/sandbox/${encodeURIComponent(sandboxId)}/ports/${port}/preview-url`,
    );
  }

  async signedPreviewUrl(
    sandboxId: string,
    port: number,
    expiresInSeconds?: number,
  ): Promise<PreviewUrlResponse> {
    return await this.api<PreviewUrlResponse>(
      "GET",
      `/sandbox/${encodeURIComponent(sandboxId)}/ports/${port}/signed-preview-url`,
      undefined,
      { expiresInSeconds },
    );
  }
}
