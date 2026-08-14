/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Sandbox } from '@daytona/sdk'
import { logger } from '../core/logger'
import { toast } from '../core/toast'
import { DaytonaSandboxGitManager } from './sandbox-git-manager'
import { HostGitManager } from './host-git-manager'
import type { PluginInput } from '@opencode-ai/plugin'

/**
 * SessionGitManager: Combines DaytonaSandboxGitManager and HostGitManager for session lifecycle git operations.
 */
export class SessionGitManager {
  private readonly sandboxGit: DaytonaSandboxGitManager
  private readonly hostGit: HostGitManager
  private readonly sandbox: Sandbox
  private readonly repoPath: string
  private readonly worktree: string
  private readonly branch: string
  private readonly localBranch: string
  /** Numbered remote (sandbox-2) matches localBranch (opencode/2) */
  private readonly remoteName: string

  constructor(sandbox: Sandbox, repoPath: string, worktree: string, branchNumber: number) {
    this.sandbox = sandbox
    this.repoPath = repoPath
    this.worktree = worktree
    this.branch = 'opencode'
    this.localBranch = `opencode/${branchNumber}`
    this.remoteName = `sandbox-${branchNumber}`
    this.sandboxGit = new DaytonaSandboxGitManager(sandbox, repoPath)
    this.hostGit = new HostGitManager()
  }

  /**
   * Allocate and reserve the next opencode/N number in the local repo at `worktree`.
   * This keeps all host-git concerns inside the git manager layer.
   */
  static allocateAndReserveBranchNumber(worktree: string, prefix = 'opencode'): number {
    return new HostGitManager().allocateAndReserveBranchNumber(worktree, prefix)
  }

  // In-flight syncs per session. OpenCode dispatches the `event` hook without awaiting it,
  // so syncs started on session.idle are invisible to callers; tracking them here lets the
  // delete path and plugin shutdown wait instead of destroying a sandbox mid-sync.
  private static pendingSyncs = new Map<string, Promise<void>>()

  /**
   * Run `fn` after any in-flight sync for this session and track it until it settles.
   * The caller of this invocation sees failures; waiters only observe completion.
   */
  static enqueueSessionSync<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = SessionGitManager.pendingSyncs.get(sessionId) ?? Promise.resolve()
    const operation = prev.then(fn)
    const stored: Promise<void> = operation.then(
      () => undefined,
      () => undefined,
    )
    SessionGitManager.pendingSyncs.set(sessionId, stored)
    stored.then(() => {
      if (SessionGitManager.pendingSyncs.get(sessionId) === stored) {
        SessionGitManager.pendingSyncs.delete(sessionId)
      }
    })
    return operation
  }

  /** Resolves when the session has no in-flight sync. Never rejects. */
  static async waitForPendingSync(sessionId: string): Promise<void> {
    let pending = SessionGitManager.pendingSyncs.get(sessionId)
    while (pending) {
      await pending
      const next = SessionGitManager.pendingSyncs.get(sessionId)
      pending = next === pending ? undefined : next
    }
  }

  /**
   * Resolves when no session has an in-flight sync, or when `timeoutMs` elapses first
   * (returns false in that case). Never rejects. The bound exists for shutdown, where a
   * sync stalled on an unreachable sandbox must not wedge process exit; the delete path
   * intentionally waits unbounded instead, because deleting mid-sync loses data.
   */
  static async waitForAllPendingSyncs(timeoutMs?: number): Promise<boolean> {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs
    while (SessionGitManager.pendingSyncs.size > 0) {
      const waits: Promise<unknown>[] = [Promise.all([...SessionGitManager.pendingSyncs.values()])]
      if (deadline !== undefined) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) return false
        waits.push(
          new Promise<void>((resolve) => {
            setTimeout(resolve, remaining).unref()
          }),
        )
      }
      await Promise.race(waits)
      if (deadline !== undefined && Date.now() >= deadline && SessionGitManager.pendingSyncs.size > 0) return false
    }
    return true
  }

  private async getSshUrl(): Promise<string> {
    const sshAccess = await this.sandbox.createSshAccess(10)
    return `ssh://${sshAccess.token}@ssh.app.daytona.io${this.repoPath}`
  }

  hasLocalRepo(): boolean {
    return this.hostGit.hasRepo(this.worktree)
  }

  /**
   * Initialize git in the sandbox and sync with host
   * Used when a new sandbox is created for a session
   */
  async initializeAndSync(pluginCtx?: PluginInput) {
    if (pluginCtx?.client?.tui) {
      toast.initialize(pluginCtx.client.tui)
    }
    try {
      // Check if local git repo exists before initializing sandbox repo
      if (!this.hostGit.hasRepo(this.worktree)) {
        // Always ensure the directory exists, even if git syncing is disabled
        await this.sandboxGit.ensureDirectory()
        logger.warn('No local git repository found. Git syncing is disabled.')
        toast.show({
          title: 'Git syncing disabled',
          message: 'No local git repository found. Git syncing is disabled for this session.',
          variant: 'warning',
        })
        return
      }

      await this.sandboxGit.ensureRepo()
      const sshUrl = await this.getSshUrl()
      const pushed = await this.hostGit.pushLocalToSandboxRemote(this.remoteName, sshUrl, this.branch, this.worktree)
      if (pushed) {
        await this.sandboxGit.resetToRemote(this.branch)
      }
    } catch (err: any) {
      toast.show({
        title: 'Git sync error',
        message: err?.message || 'Failed to sync git repo.',
        variant: 'error',
      })
      throw err
    }
  }

  /**
   * Auto-commit in the sandbox and pull latest from host
   * Used on session idle
   * Returns true if changes were synced, false if no changes or no local repo
   */
  async autoCommitAndPull(pluginCtx?: PluginInput): Promise<boolean> {
    if (pluginCtx?.client?.tui) {
      toast.initialize(pluginCtx.client.tui)
    }
    try {
      // Check if local git repo exists before attempting any git operations
      if (!this.hostGit.hasRepo(this.worktree)) {
        logger.warn('No local git repository found. Git syncing is disabled.')
        return false
      }

      await this.sandboxGit.ensureRepo()
      await this.sandboxGit.autoCommit()

      // Pull whenever the sandbox tip differs from the local opencode/N ref, not only
      // when this call created a commit: a previous sync may have committed in the
      // sandbox and then failed to pull, and a status-only check would skip those
      // stranded commits forever (and let the delete path destroy them).
      const sandboxHead = await this.sandboxGit.getHeadOid()
      if (!sandboxHead || sandboxHead === this.hostGit.getRefOid(this.worktree, `refs/heads/${this.localBranch}`)) {
        return false
      }

      const sshUrl = await this.getSshUrl()

      // Pull the branch the sandbox actually committed to, which may differ from the
      // initial 'opencode' branch, so commits are never left unsynced.
      const sandboxBranch = await this.sandboxGit.getCurrentBranch()
      await this.hostGit.pull(this.remoteName, sshUrl, sandboxBranch, this.worktree, this.localBranch)
      toast.show({
        title: 'Changes synced',
        message: `Changes have been synced to ${this.localBranch} in your local repository`,
        variant: 'success',
      })
      return true
    } catch (err: any) {
      toast.show({
        title: 'Sync failed',
        message: err?.message || 'Failed to auto-commit and pull.',
        variant: 'error',
      })
      logger.error(`[idle/git] error sandboxId=${this.sandbox.id}: ${err}`)
      throw err
    }
  }
}
