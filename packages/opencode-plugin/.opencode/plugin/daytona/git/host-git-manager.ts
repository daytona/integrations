/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { logger } from '../core/logger'
import { spawnSync } from 'child_process'
import { isAbsolute, resolve as pathResolve } from 'path'

type ExecResult = {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
}

type ExecOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

// Runs git with an explicit argument vector and no shell, so interpolated values
// (SSH URLs, refs, remote names) can never be interpreted as shell syntax.
function execGit(args: string[], options: ExecOptions = {}): ExecResult {
  const res = spawnSync('git', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...options,
  })
  if (res.error) {
    return { ok: false, stdout: '', stderr: res.error.message, status: null }
  }
  const status = typeof res.status === 'number' ? res.status : null
  return { ok: status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '', status }
}

export class HostGitManager {
  // Per-repo serialization: one queue per git-common-dir. Linked worktrees (git worktree
  // add) of the same repo share `.git/config` and refs, so they must share a queue to
  // avoid racing on `remote add/remove` and `.git/config.lock`. Different repos still
  // proceed in parallel.
  private static operationQueues = new Map<string, Promise<void>>()

  // cwd → queue-key cache. `git rev-parse --git-common-dir` shells out; caching avoids
  // running it on every enqueue. Repo layout doesn't move at runtime, so this is stable.
  private static queueKeyCache = new Map<string, string>()

  /**
   * Resolve the serialization key for a worktree: the absolute path of its shared
   * git dir (common across linked worktrees of the same repo). Falls back to the cwd
   * itself if git can't identify a repo, so per-directory serialization still applies.
   */
  private static queueKeyFor(cwd: string): string {
    const cached = HostGitManager.queueKeyCache.get(cwd)
    if (cached) return cached
    const res = execGit(['rev-parse', '--git-common-dir'], { cwd })
    let key: string
    if (!res.ok) {
      key = cwd
    } else {
      const raw = res.stdout.trim()
      key = isAbsolute(raw) ? raw : pathResolve(cwd, raw)
    }
    HostGitManager.queueKeyCache.set(cwd, key)
    return key
  }

  /**
   * Chain `fn` onto the queue for the repo containing `cwd`. The stored promise is
   * always-resolves so a failure doesn't poison the chain; callers still see errors via
   * `await` on the returned promise. Cleared from the map when the tail settles to avoid
   * leaking entries for repos that are no longer active.
   */
  private static enqueue<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    const queueKey = HostGitManager.queueKeyFor(cwd)
    const prev = HostGitManager.operationQueues.get(queueKey) ?? Promise.resolve()
    const operation = prev.then(fn)
    const stored: Promise<void> = operation.then(
      () => undefined,
      () => undefined,
    )
    HostGitManager.operationQueues.set(queueKey, stored)
    stored.then(() => {
      if (HostGitManager.operationQueues.get(queueKey) === stored) {
        HostGitManager.operationQueues.delete(queueKey)
      }
    })
    return operation
  }

  /** Cached OID of an empty commit used to reserve branch refs (branches must point at commits, not blobs). */
  private emptyCommitOidCache = new Map<string, string>()

  /**
   * Checks if a git repository exists in the current directory
   * @returns true if a git repo exists, false otherwise
   */
  hasRepo(cwd?: string): boolean {
    return execGit(['rev-parse', '--is-inside-work-tree'], cwd ? { cwd } : {}).ok
  }

  /**
   * Allocates the next available opencode/N branch number by scanning local refs and
   * reserving the chosen number by creating the ref immediately.
   *
   * This avoids relying on OpenCode's project ID and works even in repos with no commits.
   */
  allocateAndReserveBranchNumber(cwd: string, prefix = 'opencode'): number {
    const start = Date.now()
    if (!this.hasRepo(cwd)) {
      throw new Error('No local git repository found.')
    }

    const base = `refs/heads/${prefix}/`
    const listRes = execGit(['for-each-ref', '--format=%(refname:strip=3)', base], { cwd })
    if (!listRes.ok) throw new Error(listRes.stderr)
    const list = listRes.stdout.trim()
    const nums =
      list.length === 0
        ? []
        : list
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => Number.parseInt(s, 10))
            .filter((n) => Number.isFinite(n) && n > 0)

    let n = (nums.length ? Math.max(...nums) : 0) + 1
    const maxAttempts = 50 // Circuit-breaker
    let attempts = 0
    while (n < 1_000_000 && attempts < maxAttempts) {
      attempts++
      const ref = `${base}${n}`
      if (this.refExists(cwd, ref)) {
        n++
        continue
      }
      const oid = this.getOrCreateEmptyCommitOid(cwd)
      const result = execGit(['update-ref', ref, oid], { cwd })
      if (result.ok) {
        logger.info(`[branch-alloc] reserved ${prefix}/${n} in ${Date.now() - start}ms`)
        return n
      } else {
        // If we raced or hit an edge case, try the next number.
        n++
      }
    }
    const oid = this.getOrCreateEmptyCommitOid(cwd)
    const last = execGit(['update-ref', `${base}${n}`, oid], { cwd })
    if (last.ok) {
      logger.info(`[branch-alloc] reserved ${prefix}/${n} in ${Date.now() - start}ms`)
      return n
    }
    throw new Error(`Failed to allocate branch number after ${attempts} attempts. Last error: ${last.stderr}`)
  }

  private refExists(cwd: string, ref: string): boolean {
    return execGit(['show-ref', '--verify', '--quiet', ref], { cwd }).ok
  }

  /**
   * Returns a commit OID that branch refs can point at. Uses HEAD if the repo has commits,
   * otherwise creates and caches an empty commit (empty tree + commit). Branch refs must
   * point at commits, not blobs.
   */
  private getOrCreateEmptyCommitOid(cwd: string): string {
    const cached = this.emptyCommitOidCache.get(cwd)
    if (cached) return cached
    const headRes = execGit(['rev-parse', 'HEAD'], { cwd })
    const head = headRes.ok ? headRes.stdout.trim() : ''
    if (head) {
      this.emptyCommitOidCache.set(cwd, head)
      return head
    }

    // Create an empty tree (idempotent) then a commit pointing at it.
    const treeResult = spawnSync('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], {
      input: '',
      cwd,
      encoding: 'utf8',
    })
    const treeOid = treeResult.stdout?.trim()
    if (treeResult.status !== 0 || !treeOid) {
      const errorMsg =
        treeResult.stderr?.toString() || treeResult.error?.message || String(treeResult.error || 'unknown')
      throw new Error(`Failed to create empty tree: ${errorMsg}`)
    }

    // Provide a default identity for reservation commits when repo has no user.name/user.email (e.g. CI).
    const reservationCommitName = 'OpenCode Plugin'
    const reservationCommitEmail = 'opencode@daytona.io'
    const reservationCommitMessage = 'OpenCode reservation'
    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: reservationCommitName,
      GIT_AUTHOR_EMAIL: reservationCommitEmail,
      GIT_COMMITTER_NAME: reservationCommitName,
      GIT_COMMITTER_EMAIL: reservationCommitEmail,
    }

    const commitRes = execGit(['commit-tree', treeOid, '-m', reservationCommitMessage], { cwd, env: commitEnv })
    if (!commitRes.ok) throw new Error(`Failed to create empty commit: ${commitRes.stderr}`)
    const commitOid = commitRes.stdout.trim()
    this.emptyCommitOidCache.set(cwd, commitOid)
    return commitOid
  }

  /**
   * Pushes local changes to the sandbox remote.
   * @param remoteName Numbered remote (e.g. sandbox-2) matching opencode/N.
   * @param sshUrl The SSH URL of the sandbox remote.
   * @param branch The branch to push to.
   * @param cwd Worktree path to run git in.
   * @returns true if push succeeded, false if no repo exists. Throws if the push fails.
   */
  async pushLocalToSandboxRemote(remoteName: string, sshUrl: string, branch: string, cwd: string): Promise<boolean> {
    if (!this.hasRepo(cwd)) {
      logger.warn('No local git repository found. Skipping push to sandbox.')
      return false
    }
    logger.info(`Pushing to ${remoteName} (${sshUrl}) on branch ${branch}`)
    await HostGitManager.enqueue(cwd, async () => {
      const statusRes = execGit(['status', '--porcelain'], { cwd })
      if (!statusRes.ok) {
        throw new Error(statusRes.stderr)
      }
      if (statusRes.stdout.trim().length > 0) {
        logger.warn('Local repository has uncommitted changes; pushing HEAD only (no auto-commit).')
      }

      this.setRemote(remoteName, sshUrl, cwd)
      let attempts = 0
      while (attempts < 3) {
        const pushRes = execGit(['push', remoteName, `HEAD:${branch}`], { cwd })
        if (pushRes.ok) {
          logger.info(`✓ Pushed local changes to ${remoteName}`)
          return
        }
        attempts++
        if (attempts >= 3) {
          logger.error(`Error pushing to ${remoteName} after 3 attempts: ${pushRes.stderr}`)
          throw new Error(pushRes.stderr)
        }
        logger.warn(`Push attempt ${attempts} failed, retrying...`)
      }
    })
    return true
  }

  private setRemote(remoteName: string, sshUrl: string, cwd: string): void {
    // Remote may not exist yet — ignore this result. `remote add` below is the check that matters.
    execGit(['remote', 'remove', remoteName], { cwd })
    const addRes = execGit(['remote', 'add', remoteName, sshUrl], { cwd })
    if (!addRes.ok) {
      throw new Error(`Failed to configure sandbox remote '${remoteName}': ${addRes.stderr}`)
    }
  }

  async pull(remoteName: string, sshUrl: string, branch: string, cwd: string, localBranch?: string): Promise<void> {
    await HostGitManager.enqueue(cwd, async () => {
      this.setRemote(remoteName, sshUrl, cwd)
      let attempts = 0
      let lastError: unknown = undefined
      // The first pull attempt sometimes fails. I'm not sure what the cause is.
      while (attempts < 3) {
        try {
          if (localBranch) {
            // Fetch into FETCH_HEAD only (never into refs/heads) so we don't hit
            // "refusing to fetch into branch checked out" when this branch is checked out.
            const fetchRes = execGit(['fetch', remoteName, branch], { cwd })
            if (!fetchRes.ok) throw new Error(fetchRes.stderr)

            const updateRefRes = execGit(['update-ref', `refs/heads/${localBranch}`, 'FETCH_HEAD'], { cwd })
            if (!updateRefRes.ok) throw new Error(updateRefRes.stderr)

            // Only reset working directory if we're currently on this branch
            const currentBranchRes = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
            const currentBranch = currentBranchRes.ok ? currentBranchRes.stdout.trim() : ''
            if (currentBranch === localBranch) {
              const resetRes = execGit(['reset', '--hard', `refs/heads/${localBranch}`], { cwd })
              if (!resetRes.ok) throw new Error(resetRes.stderr)
            }

            logger.info(`✓ Force pulled latest changes from sandbox into ${localBranch}`)
          } else {
            const pullRes = execGit(['pull', remoteName, branch], { cwd })
            if (!pullRes.ok) throw new Error(pullRes.stderr)
            logger.info('✓ Pulled latest changes from sandbox')
          }
          return
        } catch (e) {
          lastError = e
          attempts++
          if (attempts >= 3) {
            logger.error(`Error pulling from sandbox after 3 attempts: ${e}`)
          } else {
            logger.warn(`Pull attempt ${attempts} failed, retrying...`)
          }
        }
      }

      // If we got here, all attempts failed.
      throw lastError ?? new Error('Pull failed after 3 attempts')
    })
  }

  async push(remoteName: string, sshUrl: string, branch: string, cwd: string): Promise<void> {
    await HostGitManager.enqueue(cwd, async () => {
      this.setRemote(remoteName, sshUrl, cwd)
      let attempts = 0
      while (attempts < 3) {
        const pushRes = execGit(['push', remoteName, `HEAD:${branch}`], { cwd })
        if (pushRes.ok) {
          logger.info('✓ Pushed changes to sandbox')
          return
        }
        attempts++
        if (attempts >= 3) {
          logger.error(`Error pushing to sandbox after 3 attempts: ${pushRes.stderr}`)
          throw new Error(pushRes.stderr)
        }
        logger.warn(`Push attempt ${attempts} failed, retrying...`)
      }
    })
  }
}
