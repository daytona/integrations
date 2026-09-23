/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";

export const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the Daytona component with a `convex-test` instance, e.g.:
 *
 * ```ts
 * import { convexTest } from "convex-test";
 * import daytonaTest from "@daytona/convex/test";
 * const t = convexTest(schema, modules);
 * daytonaTest.register(t);
 * ```
 */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "daytona",
) {
  t.registerComponent(name, schema, modules);
}

export default { register, schema, modules };
