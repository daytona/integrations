/// <reference types="vite/client" />
import { test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema.js";

export const modules = import.meta.glob("./**/*.*s");

export function initConvexTest() {
  return convexTest(schema, modules);
}

test("setup", () => {});
