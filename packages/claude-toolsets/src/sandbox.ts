import { Daytona } from "@daytona/sdk";
import type {
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
  Sandbox,
} from "@daytona/sdk";

export type CreateParams = CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams;
export type OnClose = "delete" | "stop";

export const LABELS = {
  "created-by": "daytona-claude-toolsets",
} as const;

export const DEFAULT_ENV = {
  VNC_RESOLUTION: "1280x800",
} as const;

export type SandboxTarget = {
  readonly id: string;
  delete(timeout?: number, wait?: boolean): Promise<void>;
  stop(timeout?: number, force?: boolean): Promise<void>;
};

export type CreateOptions = {
  readonly timeout?: number;
};

export type SandboxCreator<TSandbox extends SandboxTarget = SandboxTarget> = {
  readonly create: (
    params?: CreateParams,
    options?: CreateOptions,
  ) => Promise<TSandbox>;
};

export type AcquireOptions<TSandbox extends SandboxTarget = SandboxTarget> = {
  readonly daytona?: Daytona | SandboxCreator<TSandbox>;
  readonly createParams?: CreateParams;
  readonly defaultEnv?: Readonly<Record<string, string>>;
  readonly onClose?: OnClose;
  readonly createTimeout?: number;
};

export class SandboxLeaseConfigError extends Error {
  readonly name = "SandboxLeaseConfigError";
}

/**
 * `Daytona.create` is overloaded (snapshot params and image params), and the two overloads differ
 * only in options this package never passes. Both shapes therefore take the same call, resolved in
 * one place so neither call site has to restate the union.
 */
const createWithDaytona = async (
  daytona: Daytona,
  params: CreateParams,
  timeout: number,
): Promise<Sandbox> => daytona.create(params, { timeout });

export const withDefaults = (
  params: CreateParams | undefined,
  defaultEnv: Readonly<Record<string, string>> = DEFAULT_ENV,
): CreateParams => {
  const base = params ?? {};
  return {
    ...base,
    envVars: { ...defaultEnv, ...(base.envVars ?? {}) },
    labels: { ...(base.labels ?? {}), ...LABELS },
  };
};

export class SandboxLease<TSandbox extends SandboxTarget = SandboxTarget> {
  readonly sandbox: TSandbox;
  readonly owned: boolean;
  readonly onClose: OnClose;
  private released = false;

  private constructor(sandbox: TSandbox, owned: boolean, onClose: OnClose) {
    this.sandbox = sandbox;
    this.owned = owned;
    this.onClose = onClose;
  }

  static async acquire(
    sandbox: Sandbox | undefined,
    options?: AcquireOptions<Sandbox>,
  ): Promise<SandboxLease<Sandbox>>;
  static async acquire(
    sandbox: SandboxTarget | undefined,
    options?: AcquireOptions<SandboxTarget>,
  ): Promise<SandboxLease<SandboxTarget>>;
  static async acquire(
    sandbox: SandboxTarget | undefined,
    options: AcquireOptions<SandboxTarget> = {},
  ): Promise<SandboxLease<SandboxTarget>> {
    const onClose = options.onClose ?? "delete";
    if (onClose !== "delete" && onClose !== "stop") {
      throw new SandboxLeaseConfigError("onClose must be 'delete' or 'stop'");
    }
    if (sandbox !== undefined) {
      if (options.createParams !== undefined) {
        throw new SandboxLeaseConfigError("pass either sandbox or createParams, not both");
      }
      return new SandboxLease(sandbox, false, onClose);
    }

    const params = withDefaults(options.createParams, options.defaultEnv ?? DEFAULT_ENV);
    const timeout = options.createTimeout ?? 120;
    const client = options.daytona;
    const created =
      client instanceof Daytona
        ? await createWithDaytona(client, params, timeout)
        : client === undefined
          ? await createWithDaytona(new Daytona(), params, timeout)
          : await client.create(params, { timeout });
    return new SandboxLease(created, true, onClose);
  }

  async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    if (!this.owned) {
      return;
    }

    try {
      if (this.onClose === "delete") {
        await this.sandbox.delete();
      } else {
        await this.sandbox.stop();
      }
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.warn(
        `could not ${this.onClose} sandbox ${this.sandbox.id} (${errorName}); remove it by its label created-by=daytona-claude-toolsets`,
      );
    }
  }
}
