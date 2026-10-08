import { posix } from "node:path";
import {
  UploadRefusedError,
  type BetaFilePolicy,
  type BetaURLContext,
} from "@anthropic-ai/sdk/helpers/beta/toolsets";
import { trimTrailingSlashes } from "./text.js";

const normalizePath = (path: string): string => {
  const normalized = posix.normalize(path);
  return normalized.length > 1 ? trimTrailingSlashes(normalized) : normalized;
};

export const isFilesystemRoot = (path: string): boolean => path.startsWith("/") && normalizePath(path) === "/";

export const isUnder = (path: string, root: string): boolean => {
  if (path.split("/").includes("..") || root.split("/").includes("..")) return false;
  if (!path.startsWith("/") || !root.startsWith("/") || isFilesystemRoot(root)) return false;
  const target = normalizePath(path);
  const base = normalizePath(root);
  return target === base || target.startsWith(`${base}/`);
};

export interface DaytonaFilePolicyOptions {
  readonly uploadRoots?: readonly string[];
  readonly downloadDir?: string;
  readonly exposeDownloadPaths?: boolean;
}

export class DaytonaFilePolicy implements BetaFilePolicy {
  readonly uploadRoots: readonly string[];
  readonly downloadDir: string | undefined;
  readonly exposeDownloadPaths: boolean;

  constructor(options: DaytonaFilePolicyOptions = {}) {
    const configuredRoots = options.uploadRoots ?? [];
    if (typeof configuredRoots === "string") {
      throw new TypeError("uploadRoots is a sequence of directories, not one path");
    }
    const roots = configuredRoots.map((root) => DaytonaFilePolicy.absolute(root, "upload root"));
    if (roots.some(isFilesystemRoot)) throw new RangeError("an upload root cannot be the filesystem root");
    this.uploadRoots = roots;
    this.downloadDir = options.downloadDir === undefined ? undefined : DaytonaFilePolicy.absolute(options.downloadDir, "downloadDir");
    const downloadDir = this.downloadDir;
    // `isUnder` refuses every filesystem-root argument, so a `/` download directory would slip
    // through the overlap check below and then make `isPathVisible` hide every download.
    if (downloadDir !== undefined && isFilesystemRoot(downloadDir)) {
      throw new RangeError("downloadDir cannot be the filesystem root");
    }
    if (
      downloadDir !== undefined &&
      roots.some((root) => isUnder(downloadDir, root) || isUnder(root, downloadDir))
    ) {
      throw new RangeError("downloadDir must be outside every upload root");
    }
    this.exposeDownloadPaths = options.exposeDownloadPaths ?? false;
  }

  static forDownloadDir(policy: DaytonaFilePolicy, downloadDir: string): DaytonaFilePolicy {
    if (policy.downloadDir !== undefined) return policy;
    return new DaytonaFilePolicy({
      uploadRoots: policy.uploadRoots,
      downloadDir,
      exposeDownloadPaths: policy.exposeDownloadPaths,
    });
  }

  async resolveUploadPaths(_ctx: BetaURLContext, paths: string[]): Promise<string[]> {
    if (this.uploadRoots.length === 0) {
      throw new UploadRefusedError("File uploads by path are not enabled for this browser.");
    }
    const resolved: string[] = [];
    for (const path of paths) {
      if (!path.startsWith("/") || path.split("/").includes("..")) {
        throw new UploadRefusedError("An upload path must be an absolute path in the upload directory.");
      }
      const normal = normalizePath(path);
      if (!this.uploadRoots.some((root) => isUnder(normal, root))) {
        throw new UploadRefusedError("An upload path is outside the upload directory.");
      }
      resolved.push(normal);
    }
    return resolved;
  }

  async resolveUploadDocuments(
    _ctx: BetaURLContext,
    _documentIds: string[],
  ): Promise<string[]> {
    throw new UploadRefusedError(
      "This browser runs in a Daytona sandbox and cannot upload Files API documents; put the file in the upload directory and upload it by path.",
    );
  }

  async isPathVisible(path: string): Promise<boolean> {
    return (
      this.exposeDownloadPaths &&
      this.downloadDir !== undefined &&
      isUnder(normalizePath(path), this.downloadDir)
    );
  }

  private static absolute(path: string, what: string): string {
    if (!path || !path.startsWith("/")) throw new TypeError(`${what} must be an absolute path in the sandbox`);
    if (path.split("/").includes("..")) throw new TypeError(`${what} must not contain '..'`);
    return normalizePath(path);
  }
}
