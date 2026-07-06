/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Remote find (by filename glob).
 *
 * Pi's built-in find tool runs `fd` on the LOCAL machine. Its FindOperations
 * could in principle delegate globbing, but Daytona's `fs.searchFiles` only
 * does recursive basename matching (e.g. "star-dot-log", "marker.log") — it
 * does not understand path globs (recursive-dir patterns like the ones Pi
 * emits), which is exactly what Pi's find produces. So we run the search inside
 * the sandbox instead.
 *
 * `rg --files -g <glob>` matches `fd`'s semantics closely: it respects
 * .gitignore, supports path globs, and emits paths relative to the search dir.
 * A POSIX `find` basename fallback covers images without ripgrep.
 */

import type { Sandbox } from '@daytona/sdk'
import { execCommand } from './sandbox.ts'
import { joinPath, shellQuote } from './util.ts'

/** Mirrors Pi's findSchema. */
export interface FindParams {
  pattern: string
  path?: string
  limit?: number
}

const DEFAULT_LIMIT = 1000

export interface RemoteSearchResult {
  content: { type: 'text'; text: string }[]
  details: undefined
}

export async function runRemoteFind(sandbox: Sandbox, cwd: string, params: FindParams): Promise<RemoteSearchResult> {
  const { pattern, path: searchDir = '.', limit } = params
  // Guard against malformed input (NaN/Infinity/non-integer) before it reaches
  // `head -n`, which would otherwise become e.g. `head -n NaN`.
  const requested = limit ?? DEFAULT_LIMIT
  const max = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : DEFAULT_LIMIT
  const searchPath = searchDir.startsWith('/') ? searchDir : joinPath(cwd, searchDir)

  // Mirror Pi: a path glob (contains "/") should match at any depth.
  let effective = pattern
  if (pattern.includes('/') && !pattern.startsWith('/') && !pattern.startsWith('**/') && pattern !== '**') {
    effective = `**/${pattern}`
  }

  // Basename for the POSIX find fallback (last path segment of the pattern).
  const basename = effective.split('/').pop() || effective

  const rg = [
    'rg',
    '--files',
    '--hidden',
    '-g',
    shellQuote('!**/.git/**'),
    '-g',
    shellQuote('!**/node_modules/**'),
    '-g',
    shellQuote(effective),
  ].join(' ')

  const find = [
    'find',
    '.',
    '-type',
    'f',
    '-name',
    shellQuote(basename),
    '-not',
    '-path',
    shellQuote('*/.git/*'),
    '-not',
    '-path',
    shellQuote('*/node_modules/*'),
  ].join(' ')

  // Preserve the search's real exit code across the `head` limiter (a pipe would
  // report head's code instead). rg/grep exit >= 2 signals a genuine failure
  // (bad path, permissions) that must surface, not silently read as "no files".
  const search = `if command -v rg >/dev/null 2>&1; then ${rg}; else ${find}; fi`
  const command = [
    '__pi_out=$(mktemp 2>/dev/null || echo "/tmp/pi-find-$$.out")',
    `( ${search} ) >"$__pi_out" 2>/dev/null`,
    '__pi_rc=$?',
    `head -n ${max} "$__pi_out"`,
    'rm -f "$__pi_out"',
    'exit $__pi_rc',
  ].join('\n')
  const res = await execCommand(sandbox, command, searchPath)
  if ((res.exitCode ?? 0) >= 2) {
    throw new Error(`find failed in ${searchPath} (exit ${res.exitCode})`)
  }
  // Strip only the leading `./` and a trailing CR — never trim, which would
  // corrupt filenames with legitimate leading/trailing spaces.
  const lines = (res.result ?? res.artifacts?.stdout ?? '')
    .split('\n')
    .map((l) => l.replace(/^\.\//, '').replace(/\r$/, ''))
    .filter((l) => l.length > 0)

  const body = lines.length > 0 ? lines.join('\n') : 'No files found matching pattern'
  return { content: [{ type: 'text', text: body }], details: undefined }
}
