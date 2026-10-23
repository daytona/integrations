/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Webhook-driven sandbox state sync. Daytona delivers `sandbox.state.updated`
 * events to the route in `http.ts`; deliveries are signed (Svix / Standard
 * Webhooks scheme) with the endpoint's `whsec_…` secret, which the app passes
 * down to the component as `DAYTONA_WEBHOOK_SECRET`.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";

/** Reject deliveries whose timestamp is further than this from now (replays). */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

function header(headers: Headers, name: string): string | null {
  // Svix sends svix-*; the Standard Webhooks spec uses webhook-*.
  return headers.get(`svix-${name}`) ?? headers.get(`webhook-${name}`);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Length-safe constant-time comparison (no early exit on mismatch). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signPayload(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const keyBytes = base64ToBytes(secret.replace(/^whsec_/, ""));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return bytesToBase64(signature);
}

/**
 * Verify a delivery against the raw request body: HMAC-SHA256 over
 * `id.timestamp.body`, matched against any `v1,` entry in the signature
 * header, with a bounded timestamp to prevent replays.
 */
export async function verifyWebhook(
  secret: string,
  headers: Headers,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  const id = header(headers, "id");
  const timestamp = header(headers, "timestamp");
  const signatures = header(headers, "signature");
  if (!id || !timestamp || !signatures) {
    return { ok: false, reason: "missing signature headers" };
  }
  const sentAt = Number(timestamp);
  if (
    !Number.isFinite(sentAt) ||
    Math.abs(nowSeconds - sentAt) > TIMESTAMP_TOLERANCE_SECONDS
  ) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }
  let expected: string;
  try {
    expected = await signPayload(secret, id, timestamp, body);
  } catch {
    return { ok: false, reason: "malformed webhook secret" };
  }
  // The header can carry several space-separated signatures (key rotation).
  const matched = signatures
    .split(" ")
    .map((entry) => entry.split(","))
    .some(
      ([version, signature]) =>
        version === "v1" &&
        signature !== undefined &&
        timingSafeEqual(signature, expected),
    );
  return matched ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/**
 * Apply a `sandbox.state.updated` event. Only sandboxes this component
 * tracks are updated (endpoints receive every sandbox in the organization),
 * and events older than the last applied one are discarded, so duplicate and
 * out-of-order deliveries converge on the newest state.
 */
export const applyStateEvent = internalMutation({
  args: {
    sandboxId: v.string(),
    state: v.string(),
    /** Daytona's event time in ms. */
    eventTime: v.number(),
  },
  returns: v.union(
    v.literal("applied"),
    v.literal("ignored-unknown"),
    v.literal("ignored-stale"),
  ),
  handler: async (ctx, args) => {
    const sandbox = await ctx.db
      .query("sandboxes")
      .withIndex("sandboxId", (q) => q.eq("sandboxId", args.sandboxId))
      .unique();
    if (!sandbox) return "ignored-unknown";
    if (
      sandbox.remoteUpdatedAt !== undefined &&
      args.eventTime <= sandbox.remoteUpdatedAt
    ) {
      return "ignored-stale";
    }
    await ctx.db.patch(sandbox._id, {
      state: args.state,
      remoteUpdatedAt: args.eventTime,
      updatedAt: Date.now(),
    });
    return "applied";
  },
});
