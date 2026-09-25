/// <reference types="vite/client" />
import { test } from "vitest";
import { convexTest } from "convex-test";
import daytonaTest from "@daytona/convex/test";
import schema from "./schema.js";

export const modules = import.meta.glob("./**/*.*s");

export function initConvexTest() {
  const t = convexTest(schema, modules);
  daytonaTest.register(t);
  return t;
}

test("setup", () => {});
