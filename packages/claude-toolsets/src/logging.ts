/**
 * The package's own log output, and the only output it writes.
 *
 * Python's driver logs through `logging.getLogger("daytona_claude_toolsets")`, so a host
 * application can see which lines are the driver's and silence them on their own. Node has no
 * logger registry to borrow, so the namespace is carried in the line itself: every message goes
 * out with the package name in front of it, through the host's own `console`.
 *
 * `debug` carries the best-effort cleanup and fail-closed policy failures the driver deliberately
 * swallows — none of them fails a call, and none of them is actionable on its own. `warn` is for
 * the two a human has to act on: a sandbox that could not be released, and a URL policy that threw
 * instead of answering.
 *
 * Nothing here is re-exported from `index.ts`: these are the module's own voice, not API.
 */

const PREFIX = "[daytona-claude-toolsets] ";

export const warn = (message: string): void => {
  console.warn(`${PREFIX}${message}`);
};

export const debug = (message: string): void => {
  console.debug(`${PREFIX}${message}`);
};

/**
 * The name of what was thrown, standing in for Python's `type(exc).__name__`.
 *
 * Only the class name is logged, never the message: an exception text can carry the signed preview
 * URL, a sandbox path or a page's own string, and none of those belong in a host's log.
 * `error.name` is a plain writable instance property reachable by anything holding the error,
 * including a page's own thrown value in the browser driver, so it cannot be trusted to remain the
 * real class name; `error.constructor.name` reads the class identity instead.
 */
export const errorName = (error: unknown): string =>
  error instanceof Error ? error.constructor.name : "UnknownError";
