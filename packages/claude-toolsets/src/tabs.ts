import type { CDPSession, Page } from "playwright-core";
import { MAX_TEXT } from "./text.js";

export const MAX_ENTRIES = 1000;

export interface TabRequest {
  method(): string;
  url(): string;
  timing(): { readonly responseEnd: number };
}

export interface TabResponse {
  request(): TabRequest;
  status(): number;
  headers(): Readonly<Record<string, string>>;
}

type NetworkEntry = {
  method: string;
  url: string;
  status: string;
  type?: string;
  ms?: number;
};

/** Mutable per-tab accumulator; mutation is the purpose of this record. */
export class Tab<PageType = Page, CdpType = CDPSession> {
  readonly id: string;
  readonly page: PageType;
  cdp: CdpType | null = null;
  targetId: string | null = null;
  world: number | null = null;
  title = "";
  readonly console: string[] = [];
  readonly network = new Map<TabRequest, NetworkEntry>();
  droppedConsole = 0;
  droppedNetwork = 0;

  constructor(id: string, page: PageType) {
    this.id = id;
    this.page = page;
  }

  log(line: string): void {
    if (this.console.length === MAX_ENTRIES) this.droppedConsole += 1;
    if (this.console.length === MAX_ENTRIES) this.console.shift();
    this.console.push(line.slice(0, MAX_TEXT));
  }

  takeConsole(): string {
    const lines = [...this.console];
    if (this.droppedConsole > 0) lines.unshift(`[${this.droppedConsole} earlier entries were dropped]`);
    this.console.length = 0;
    this.droppedConsole = 0;
    return lines.join("\n");
  }

  startRequest(request: TabRequest): void {
    if (this.network.size >= MAX_ENTRIES) {
      const oldest = this.network.keys().next();
      if (!oldest.done) {
        this.network.delete(oldest.value);
        this.droppedNetwork += 1;
      }
    }
    this.network.set(request, {
      method: request.method(),
      url: request.url().slice(0, MAX_TEXT),
      status: "pending",
    });
  }

  answerRequest(response: TabResponse): void {
    const entry = this.network.get(response.request());
    if (entry === undefined) return;
    entry.status = String(response.status());
    entry.type = (response.headers()["content-type"] ?? "").split(";")[0] ?? "";
  }

  finishRequest(request: TabRequest, failure: string | null | undefined): void {
    const entry = this.network.get(request);
    if (entry === undefined) return;
    if (failure !== null && failure !== undefined) entry.status = `failed (${failure})`;
    const end = request.timing().responseEnd;
    if (end >= 0) entry.ms = Math.round(end);
  }

  takeNetwork(): string {
    const lines = [...this.network.values()].map((entry) =>
      [entry.method, entry.status, entry.type ?? "", entry.ms === undefined ? "" : `${entry.ms}ms`, entry.url]
        .filter(Boolean)
        .join(" "),
    );
    if (this.droppedNetwork > 0) lines.unshift(`[${this.droppedNetwork} earlier requests were dropped]`);
    for (const [request, entry] of this.network) {
      if (entry.status !== "pending") this.network.delete(request);
    }
    this.droppedNetwork = 0;
    return lines.join("\n");
  }
}
