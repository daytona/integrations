/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sandbox filesystem actions (Daytona toolbox files API). Content crosses the
 * Convex function boundary as UTF-8 strings — fine for source files and text
 * artifacts. Keep individual files under Convex's function argument/return
 * limits (16 MiB); move bigger payloads via URLs inside the sandbox instead.
 */

import { v } from "convex/values";
import { action } from "./_generated/server.js";
import { DaytonaClient } from "./daytona.js";
import { configValidator } from "./types.js";

export const readFile = action({
  args: {
    config: configValidator,
    sandboxId: v.string(),
    path: v.string(),
  },
  returns: v.string(),
  handler: async (_ctx, args) => {
    const client = new DaytonaClient(args.config);
    return await client.downloadFile(args.sandboxId, args.path);
  },
});

export const writeFile = action({
  args: {
    config: configValidator,
    sandboxId: v.string(),
    path: v.string(),
    content: v.string(),
  },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const client = new DaytonaClient(args.config);
    await client.uploadFile(args.sandboxId, args.path, args.content);
    return null;
  },
});

export const listFiles = action({
  args: {
    config: configValidator,
    sandboxId: v.string(),
    path: v.string(),
  },
  returns: v.array(
    v.object({
      name: v.string(),
      isDir: v.boolean(),
      size: v.optional(v.number()),
      modTime: v.optional(v.string()),
    }),
  ),
  handler: async (_ctx, args) => {
    const client = new DaytonaClient(args.config);
    const files = await client.listFiles(args.sandboxId, args.path);
    return files.map((file) => ({
      name: file.name,
      isDir: Boolean(file.isDir),
      size: typeof file.size === "number" ? file.size : undefined,
      modTime: typeof file.modTime === "string" ? file.modTime : undefined,
    }));
  },
});

export const deleteFile = action({
  args: {
    config: configValidator,
    sandboxId: v.string(),
    path: v.string(),
    recursive: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const client = new DaytonaClient(args.config);
    await client.deleteFile(args.sandboxId, args.path, args.recursive);
    return null;
  },
});
