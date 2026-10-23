import { Daytona, type Sandbox } from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ENV,
  LABELS,
  SandboxLease,
  type SandboxCreator,
  type SandboxTarget,
  withDefaults,
} from "../src/sandbox.js";

type FakeSandbox = SandboxTarget & {
  readonly delete: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

const fakeSandbox = (): FakeSandbox => ({
  id: "sbx-test",
  delete: vi.fn<() => Promise<void>>(async () => undefined),
  stop: vi.fn<() => Promise<void>>(async () => undefined),
});

const fakeCreator = (sandbox: FakeSandbox): SandboxCreator<FakeSandbox> => ({
  create: vi.fn(async () => sandbox),
});

describe("sandbox lease", () => {
  it("keeps caller-owned create params immutable while applying G6 precedence", () => {
    // Given: caller values conflict with both package defaults.
    const params = {
      labels: { "created-by": "caller", purpose: "demo" },
      envVars: { VNC_RESOLUTION: "1024x768", OTHER: "caller" },
      autoStopInterval: 7,
    };
    const before = structuredClone(params);

    // When: package defaults are applied.
    const result = withDefaults(params, DEFAULT_ENV);

    // Then: env caller-wins, labels package-wins, and the input is unchanged.
    expect(result.envVars).toEqual({ VNC_RESOLUTION: "1024x768", OTHER: "caller" });
    expect(result.labels).toEqual({ "created-by": LABELS["created-by"], purpose: "demo" });
    expect(params).toEqual(before);
  });

  it("uses the default snapshot params and resolution when no create params are supplied", () => {
    // Given: no caller create params.
    // When: package defaults are applied.
    const result = withDefaults(undefined);

    // Then: the default snapshot shape carries the package label and 1280x800 desktop.
    expect(result).toEqual({ envVars: { "VNC_RESOLUTION": "1280x800" }, labels: LABELS });
  });

  it("creates and deletes an owned sandbox exactly once", async () => {
    // Given: a creator returning a sandbox.
    const sandbox = fakeSandbox();
    const creator = fakeCreator(sandbox);

    // When: an owned lease is acquired and released twice.
    const lease = await SandboxLease.acquire(undefined, { daytona: creator });
    await lease.release();
    await lease.release();

    // Then: the owned sandbox is deleted once and never stopped.
    expect(sandbox.delete).toHaveBeenCalledOnce();
    expect(sandbox.stop).not.toHaveBeenCalled();
  });

  it.each([
    ["snapshot", { snapshot: "default" }],
    ["image", { image: "debian:12.9" }],
  ])("passes %s create params and the timeout through a real Daytona client", async (_shape, createParams) => {
    // Given: a Daytona client whose create is observed (this is the `instanceof Daytona` path).
    const sandbox = fakeSandbox();
    const daytona = new Daytona({ apiKey: "dtn_test", apiUrl: "https://example.invalid/api" });
    const create = vi.fn(async () => sandbox as unknown as Sandbox);
    daytona.create = create as unknown as Daytona["create"];

    // When: an owned lease is acquired with those create params and a non-default timeout.
    await SandboxLease.acquire(undefined, { daytona, createParams, createTimeout: 45 });

    // Then: both shapes reach create unchanged, carrying the package defaults and the timeout.
    expect(create).toHaveBeenCalledWith(
      { ...createParams, envVars: DEFAULT_ENV, labels: LABELS },
      { timeout: 45 },
    );
  });

  it("stops an owned sandbox when requested", async () => {
    // Given: an owned sandbox lease configured for stop-on-close.
    const sandbox = fakeSandbox();
    const creator = fakeCreator(sandbox);
    const lease = await SandboxLease.acquire(undefined, { daytona: creator, onClose: "stop" });

    // When: the lease is released.
    await lease.release();

    // Then: stop is used instead of delete.
    expect(sandbox.stop).toHaveBeenCalledOnce();
    expect(sandbox.delete).not.toHaveBeenCalled();
  });

  it("never closes a borrowed sandbox", async () => {
    // Given: a sandbox handed to the driver.
    const sandbox = fakeSandbox();
    const lease = await SandboxLease.acquire(sandbox, { onClose: "delete" });

    // When: the borrowed lease is released.
    await lease.release();

    // Then: the caller's sandbox remains untouched.
    expect(sandbox.delete).not.toHaveBeenCalled();
    expect(sandbox.stop).not.toHaveBeenCalled();
  });

  it("swallows release failures and preserves the exact warning text", async () => {
    // Given: deletion fails after an owned sandbox was created.
    const sandbox = fakeSandbox();
    const failure = new Error("delete failed");
    sandbox.delete.mockRejectedValueOnce(failure);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const lease = await SandboxLease.acquire(undefined, { daytona: fakeCreator(sandbox) });

    // When: the lease is released.
    await lease.release();

    // Then: cleanup failure is logged without escaping the close path.
    expect(warn).toHaveBeenCalledWith(
      "[daytona-claude-toolsets] could not delete sandbox sbx-test (Error); remove it by its label created-by=daytona-claude-toolsets",
    );
    warn.mockRestore();
  });

  it("allows a construction failure to release the already-created sandbox", async () => {
    // Given: construction created an owned sandbox before a later setup step failed.
    const sandbox = fakeSandbox();
    const lease = await SandboxLease.acquire(undefined, { daytona: fakeCreator(sandbox) });

    // When: the caller releases during its failure cleanup.
    await lease.release();

    // Then: the partial construction does not leak its sandbox.
    expect(sandbox.delete).toHaveBeenCalledOnce();
  });
});
