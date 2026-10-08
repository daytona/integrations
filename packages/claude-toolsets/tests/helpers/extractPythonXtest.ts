import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_MARKER = 'SCRIPT = r"""';

export const extractPythonXtestScript = (source: string): string => {
  const start = source.indexOf(SCRIPT_MARKER);
  if (start < 0) {
    throw new Error("Could not find the Python XTest SCRIPT literal");
  }
  const contentStart = start + SCRIPT_MARKER.length;
  const end = source.indexOf('"""', contentStart);
  if (end < 0) {
    throw new Error("Could not find the end of the Python XTest SCRIPT literal");
  }
  return source.slice(contentStart, end);
};

export const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const readPythonXtestScript = (): string => {
  const helperDirectory = dirname(fileURLToPath(import.meta.url));
  const pythonPath = resolve(
    helperDirectory,
    "../../../daytona-claude-toolsets/daytona_claude_toolsets/_xtest.py",
  );
  return extractPythonXtestScript(readFileSync(pythonPath, "utf8"));
};
