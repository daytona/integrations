/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { signPayload, verifyWebhook } from "./webhooks.js";

const SECRET = `whsec_${btoa("test-webhook-secret-0123456789")}`;

describe("signature scheme compatibility", () => {
  test("reproduces Svix's published test vector", async () => {
    // From Svix's verification docs: secret, msg id, timestamp, payload and
    // the signature Svix itself produces for them.
    const signature = await signPayload(
      "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      "msg_p5jXN8AQM9LWM0D4loKWxJek",
      "1614265330",
      '{"test": 2432232314}',
    );
    expect(signature).toBe("g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");

    const headers = new Headers({
      "svix-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
      "svix-timestamp": "1614265330",
      "svix-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    });
    expect(
      await verifyWebhook(
        "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
        headers,
        '{"test": 2432232314}',
        1614265330,
      ),
    ).toEqual({ ok: true });
  });
});

describe("webhook route", () => {
  beforeEach(() => {
    vi.stubEnv("DAYTONA_WEBHOOK_SECRET", SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const stateEvent = (id: string, newState: string, updatedAt: string) =>
    JSON.stringify({
      event: "sandbox.state.updated",
      timestamp: updatedAt,
      id,
      organizationId: "org-1",
      oldState: "started",
      newState,
      updatedAt,
    });

  async function deliver(
    t: ReturnType<typeof initConvexTest>,
    body: string,
    options: {
      secret?: string;
      timestamp?: number;
      headerPrefix?: "svix" | "webhook";
      tamper?: (body: string) => string;
      extraSignatures?: string[];
    } = {},
  ) {
    const id = `msg_${Math.random().toString(36).slice(2)}`;
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const signature = await signPayload(
      options.secret ?? SECRET,
      id,
      timestamp,
      body,
    );
    const prefix = options.headerPrefix ?? "svix";
    return await t.fetch("/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [`${prefix}-id`]: id,
        [`${prefix}-timestamp`]: timestamp,
        [`${prefix}-signature`]: [
          ...(options.extraSignatures ?? []),
          `v1,${signature}`,
        ].join(" "),
      },
      body: options.tamper ? options.tamper(body) : body,
    });
  }

  async function seed(t: ReturnType<typeof initConvexTest>, sandboxId: string) {
    await t.mutation(internal.sandboxes.upsertSandbox, {
      sandboxId,
      state: "started",
    });
  }

  const stateOf = async (t: ReturnType<typeof initConvexTest>, id: string) =>
    (await t.query(api.sandboxes.get, { sandboxId: id }))?.state;

  test("a signed state event updates a tracked sandbox", async () => {
    const t = initConvexTest();
    await seed(t, "sbx-1");
    const response = await deliver(
      t,
      stateEvent("sbx-1", "stopped", "2026-10-02T10:00:00.000Z"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "applied" });
    expect(await stateOf(t, "sbx-1")).toBe("stopped");
  });

  test("Standard Webhooks headers (webhook-*) are accepted too", async () => {
    const t = initConvexTest();
    await seed(t, "sbx-1");
    const response = await deliver(
      t,
      stateEvent("sbx-1", "stopped", "2026-10-02T10:00:00.000Z"),
      { headerPrefix: "webhook" },
    );
    expect(response.status).toBe(200);
    expect(await stateOf(t, "sbx-1")).toBe("stopped");
  });

  test("any valid entry in a multi-signature header is accepted (rotation)", async () => {
    const t = initConvexTest();
    await seed(t, "sbx-1");
    const response = await deliver(
      t,
      stateEvent("sbx-1", "stopped", "2026-10-02T10:00:00.000Z"),
      { extraSignatures: ["v1,bm90LXRoZS1yaWdodC1zaWduYXR1cmU="] },
    );
    expect(response.status).toBe(200);
  });

  test("tampered body, wrong secret and stale timestamp are rejected", async () => {
    const t = initConvexTest();
    await seed(t, "sbx-1");
    const body = stateEvent("sbx-1", "stopped", "2026-10-02T10:00:00.000Z");

    const tampered = await deliver(t, body, {
      tamper: (b) => b.replace("stopped", "destroyed"),
    });
    expect(tampered.status).toBe(401);

    const wrongSecret = await deliver(t, body, {
      secret: `whsec_${btoa("some-other-secret")}`,
    });
    expect(wrongSecret.status).toBe(401);

    const replayed = await deliver(t, body, {
      timestamp: Math.floor(Date.now() / 1000) - 10 * 60,
    });
    expect(replayed.status).toBe(401);

    const unsigned = await t.fetch("/webhook", { method: "POST", body });
    expect(unsigned.status).toBe(401);

    expect(await stateOf(t, "sbx-1")).toBe("started");
  });

  test("refuses everything when no secret is configured", async () => {
    const t = initConvexTest();
    await seed(t, "sbx-1");
    vi.stubEnv("DAYTONA_WEBHOOK_SECRET", undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await deliver(
        t,
        stateEvent("sbx-1", "stopped", "2026-10-02T10:00:00.000Z"),
      );
      expect(response.status).toBe(500);
      expect(await stateOf(t, "sbx-1")).toBe("started");
    } finally {
      consoleError.mockRestore();
    }
  });

  test("untracked sandboxes and other event types are acknowledged, not applied", async () => {
    const t = initConvexTest();
    const unknown = await deliver(
      t,
      stateEvent("sbx-someone-elses", "stopped", "2026-10-02T10:00:00.000Z"),
    );
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ result: "ignored-unknown" });
    expect(await stateOf(t, "sbx-someone-elses")).toBeUndefined();

    const otherEvent = await deliver(
      t,
      JSON.stringify({ event: "snapshot.created", id: "snap-1" }),
    );
    expect(otherEvent.status).toBe(200);
    expect(await otherEvent.json()).toEqual({ result: "ignored-event" });
  });

  test("out-of-order and duplicate deliveries converge on the newest state", async () => {
    const t = initConvexTest();
    await seed(t, "sbx-1");
    const newer = stateEvent("sbx-1", "stopped", "2026-10-02T10:05:00.000Z");
    const older = stateEvent("sbx-1", "started", "2026-10-02T10:00:00.000Z");

    expect(await (await deliver(t, newer)).json()).toEqual({ result: "applied" });
    expect(await (await deliver(t, older)).json()).toEqual({
      result: "ignored-stale",
    });
    expect(await (await deliver(t, newer)).json()).toEqual({
      result: "ignored-stale",
    });
    expect(await stateOf(t, "sbx-1")).toBe("stopped");
  });
});
