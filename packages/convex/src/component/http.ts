/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The component's HTTP routes, mounted by the app under its `httpPrefix`
 * (e.g. `app.use(daytona, { httpPrefix: "/daytona/" })` exposes
 * `https://<deployment>.convex.site/daytona/webhook`).
 */

import { httpRouter } from "convex/server";
import { internal } from "./_generated/api.js";
import { env, httpAction } from "./_generated/server.js";
import { verifyWebhook } from "./webhooks.js";

const http = httpRouter();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

http.route({
  path: "/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = env.DAYTONA_WEBHOOK_SECRET;
    if (!secret) {
      // Fail closed: without a secret anyone could forge state changes.
      console.error(
        "Daytona webhook received but DAYTONA_WEBHOOK_SECRET is not passed " +
          "down to the component — refusing it. See the README's webhook setup.",
      );
      return json(500, { error: "webhook secret not configured" });
    }

    // Verify against the raw body: re-serialized JSON wouldn't match.
    const body = await request.text();
    const verified = await verifyWebhook(secret, request.headers, body);
    if (!verified.ok) {
      return json(401, { error: verified.reason });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return json(400, { error: "invalid JSON" });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json(400, { error: "payload must be a JSON object" });
    }
    const event = parsed as Record<string, unknown>;

    // Other event types are valid deliveries we don't use: acknowledge them
    // (2xx) so they aren't retried.
    if (event.event !== "sandbox.state.updated") {
      return json(200, { result: "ignored-event" });
    }
    const str = (value: unknown) =>
      typeof value === "string" && value.length > 0 ? value : undefined;
    const sandboxId = str(event.id);
    const newState = str(event.newState);
    const eventTime = Date.parse(str(event.updatedAt) ?? str(event.timestamp) ?? "");
    if (!sandboxId || !newState || !Number.isFinite(eventTime)) {
      return json(400, { error: "malformed sandbox.state.updated payload" });
    }

    const result = await ctx.runMutation(internal.webhooks.applyStateEvent, {
      sandboxId,
      state: newState,
      eventTime,
    });
    return json(200, { result });
  }),
});

export default http;
