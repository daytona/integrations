/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manages Daytona sandbox sessions and persists session-sandbox mappings
 * Stores data per-project in ~/.local/share/opencode/storage/daytona/{projectId}.json
 */

import {
  Daytona,
  DaytonaNotFoundError,
  DaytonaValidationError,
  type CreateSandboxFromSnapshotParams,
  type Sandbox,
} from '@daytona/sdk'
import { logger } from './logger'
import type { SessionSandboxMap, SandboxInfo, SessionInfo } from './types'
import { SessionGitManager } from '../git/session-git-manager'
import { DaytonaSandboxGitManager } from '../git/sandbox-git-manager'
import { ProjectDataStorage } from './project-data-storage'
import type { PluginInput } from '@opencode-ai/plugin'
import { toast } from './toast'

export class DaytonaSessionManager {
  private readonly apiKey: string
  private readonly dataStorage: ProjectDataStorage
  private sessionSandboxes: SessionSandboxMap
  // Sessions whose sandbox teardown has begun. getSandbox creates sandboxes on demand,
  // so without this tombstone a sync queued behind a deletion would resurrect a fresh
  // sandbox for a session that no longer exists (invisible, billed, never cleaned up).
  private readonly deletingSessions = new Set<string>()
  private readonly deletionPromises = new Map<string, Promise<boolean>>()
  private currentProjectId?: string
  public readonly repoPath: string
  /** Snapshot new sandboxes are created from; undefined uses Daytona's default snapshot. */
  public readonly snapshot?: string

  constructor(apiKey: string, storageDir: string, repoPath: string, snapshot?: string) {
    this.apiKey = apiKey
    this.dataStorage = new ProjectDataStorage(storageDir)
    this.repoPath = repoPath
    this.snapshot = snapshot?.trim() || undefined
    this.sessionSandboxes = new Map()
  }

  /**
   * Check if a sandbox is fully initialized (has process property)
   */
  private isFullyInitialized(sandbox: Sandbox | SandboxInfo | undefined): sandbox is Sandbox {
    return sandbox !== undefined && 'process' in sandbox
  }

  /**
   * Check if a sandbox is partially initialized (has id but not process)
   */
  private isPartiallyInitialized(sandbox: Sandbox | SandboxInfo | undefined): sandbox is SandboxInfo {
    return sandbox !== undefined && 'id' in sandbox && !('process' in sandbox)
  }

  /**
   * Load sessions for a specific project into memory
   */
  private loadProjectSessions(projectId: string): void {
    const projectData = this.dataStorage.load(projectId)
    if (projectData) {
      for (const [sessionId, sessionInfo] of Object.entries(projectData.sessions)) {
        this.sessionSandboxes.set(sessionId, { id: sessionInfo.sandboxId })
      }
      logger.info(`Loaded ${Object.keys(projectData.sessions).length} sessions for project ${projectId}`)
    }
  }

  /**
   * Set the current project context
   */
  setProjectContext(projectId: string): void {
    if (this.currentProjectId !== projectId) {
      this.currentProjectId = projectId
      this.sessionSandboxes.clear()
      this.loadProjectSessions(projectId)
    }
  }

  /**
   * Get branch number for a sandbox
   */
  getBranchNumberForSandbox(projectId: string, sandboxId: string): number | undefined {
    return this.dataStorage.getBranchNumberForSandbox(projectId, sandboxId)
  }

  /**
   * Get or create a sandbox for the given session ID
   */
  async getSandbox(sessionId: string, projectId: string, worktree: string, pluginCtx?: PluginInput): Promise<Sandbox> {
    if (pluginCtx?.client?.tui) {
      toast.initialize(pluginCtx.client.tui)
    }
    if (this.deletingSessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} is deleted; not creating a new sandbox for it.`)
    }
    if (!this.apiKey) {
      logger.error('DAYTONA_API_KEY is not set. Cannot create or retrieve sandbox.')
      toast.show({
        title: 'Sandbox error',
        message: 'DAYTONA_API_KEY is not set. Please set the environment variable to use Daytona sandboxes.',
        variant: 'error',
      })
      throw new Error('DAYTONA_API_KEY is not set. Please set the environment variable to use Daytona sandboxes.')
    }

    // Load project sessions if needed
    this.setProjectContext(projectId)

    const existing = this.sessionSandboxes.get(sessionId)

    // If we have a fully initialized sandbox, reuse it
    if (this.isFullyInitialized(existing)) {
      // Refresh sandbox state and ensure it's running
      await existing.refreshData()
      if (existing.state !== 'started') {
        logger.info(`Starting sandbox ${existing.id} (current state: ${existing.state})`)
        await existing.start()
      }
      this.ensureNotDeleted(sessionId)
      this.dataStorage.updateSession(projectId, worktree, sessionId, existing.id)
      return existing
    }

    // If we have a sandboxId but not a full sandbox object, reconnect to it
    if (this.isPartiallyInitialized(existing)) {
      try {
        logger.info(`Reconnecting to existing sandbox: ${existing.id}`)
        const daytona = new Daytona({ apiKey: this.apiKey })
        const reconnectStart = Date.now()
        logger.info(`Daytona get begin sandboxId=${existing.id}`)
        const sandbox = await daytona.get(existing.id)
        logger.info(`Daytona get done sandboxId=${existing.id} in ${Date.now() - reconnectStart}ms`)
        logger.info(`Starting sandbox begin sandboxId=${sandbox.id}`)
        await sandbox.start()
        logger.info(`Starting sandbox done sandboxId=${sandbox.id} in ${Date.now() - reconnectStart}ms`)
        this.ensureNotDeleted(sessionId)
        this.sessionSandboxes.set(sessionId, sandbox)
        // Preserve branch number if it exists for this sandbox
        let branchNumber = this.dataStorage.getBranchNumberForSandbox(projectId, sandbox.id)
        if (!branchNumber) {
          try {
            branchNumber = SessionGitManager.allocateAndReserveBranchNumber(worktree)
          } catch {
            // No local git repo (or git unavailable) shouldn't block sandbox usage.
            branchNumber = undefined
          }
        }
        this.dataStorage.updateSession(projectId, worktree, sessionId, sandbox.id, branchNumber)
        toast.show({
          title: 'Sandbox connected',
          message: `Connected to existing sandbox.`,
          variant: 'info',
        })

        // Even if git syncing is disabled, ensure the project directory exists in the sandbox.
        if (!branchNumber) {
          try {
            await new DaytonaSandboxGitManager(sandbox, this.repoPath).ensureDirectory()
          } catch (err) {
            logger.warn(`Failed to ensure sandbox project directory exists: ${err}`)
          }
        }

        return sandbox
      } catch (err) {
        // Only treat 404 as "sandbox is confirmed gone" — clear the mapping and fall through
        // to create a replacement. For transient errors (network, auth, timeout, provisioning),
        // preserve the mapping and propagate so the caller can retry later without losing the
        // session→sandbox binding and its branchNumber.
        if (err instanceof DaytonaNotFoundError) {
          logger.error(`Sandbox ${existing.id} no longer exists; creating a replacement.`)
          this.sessionSandboxes.delete(sessionId)
          this.dataStorage.removeSession(projectId, worktree, sessionId)
        } else {
          logger.error(`Failed to reconnect to sandbox ${existing.id}: ${err}`)
          throw err
        }
      }
    }

    // If not in cache/storage for this project, try to recover from other projects and migrate.
    if (!existing) {
      const migrated = this.dataStorage.getSession(projectId, worktree, sessionId)
      if (migrated?.sandboxId) {
        logger.info(`Recovered session ${sessionId} for project ${projectId} (migrated from another project)`)
        this.sessionSandboxes.set(sessionId, { id: migrated.sandboxId })
        // Re-run getSandbox to go through the normal reconnect path.
        return this.getSandbox(sessionId, projectId, worktree, pluginCtx)
      }
    }

    // Otherwise, create a new sandbox
    logger.info(`Creating new sandbox for session: ${sessionId} in project: ${projectId}`)
    const daytona = new Daytona({ apiKey: this.apiKey })
    // Omit the key entirely when unset so Daytona applies its default snapshot.
    const createParams: CreateSandboxFromSnapshotParams = this.snapshot ? { snapshot: this.snapshot } : {}
    const createStart = Date.now()
    logger.info(`Daytona create begin sessionId=${sessionId} snapshot=${this.snapshot ?? '(default)'}`)
    const waitingLog = setTimeout(() => {
      logger.warn(`Daytona create still waiting after ${Date.now() - createStart}ms (sessionId=${sessionId})`)
    }, 15_000)
    const sandbox = await daytona
      .create(createParams)
      .catch((err: unknown) => {
        // Only blame the snapshot when the request itself was rejected. The create
        // params contain nothing but the snapshot name, so a validation error means
        // Daytona refused that name (empirically: "Snapshot <name> not found" is a
        // DaytonaValidationError). Auth, network, quota, and timeout failures are
        // unrelated to DAYTONA_SNAPSHOT and propagate unattributed, as before.
        if (this.snapshot && err instanceof DaytonaValidationError) {
          logger.error(`Failed to create sandbox from snapshot '${this.snapshot}': ${err}`)
          toast.show({
            title: 'Sandbox error',
            message: `Verify DAYTONA_SNAPSHOT names an available snapshot: ${err.message}`,
            variant: 'error',
          })
        }
        throw err
      })
      .finally(() => clearTimeout(waitingLog))
    logger.info(`Daytona create done sessionId=${sessionId} sandboxId=${sandbox.id} in ${Date.now() - createStart}ms`)
    if (this.deletingSessions.has(sessionId)) {
      // The session was deleted while creation was in flight. The fresh sandbox is not
      // registered anywhere, so nothing else will ever clean it up - discard it here.
      logger.warn(`Session ${sessionId} was deleted during sandbox creation; discarding sandbox ${sandbox.id}`)
      try {
        await sandbox.delete()
      } catch (err) {
        logger.error(`Failed to discard sandbox ${sandbox.id} for deleted session ${sessionId}: ${err}`)
        throw new Error(
          `Session ${sessionId} is deleted and discarding newly created sandbox ${sandbox.id} failed; if it still exists, delete it from the Daytona dashboard.`,
        )
      }
      throw new Error(`Session ${sessionId} is deleted; the newly created sandbox was discarded.`)
    }
    this.sessionSandboxes.set(sessionId, sandbox)

    // Get or assign branch number for this sandbox
    let branchNumber = this.dataStorage.getBranchNumberForSandbox(projectId, sandbox.id)

    if (!branchNumber) {
      try {
        branchNumber = SessionGitManager.allocateAndReserveBranchNumber(worktree)
      } catch (err: any) {
        logger.warn(`allocateAndReserveBranchNumber failed sessionId=${sessionId}: ${err}`)
        // No local git repo (or git unavailable) shouldn't block sandbox usage.
        branchNumber = undefined
      }
    }

    this.dataStorage.updateSession(projectId, worktree, sessionId, sandbox.id, branchNumber)
    logger.info(
      `Sandbox created successfully: ${sandbox.id}${branchNumber ? ` with branch number ${branchNumber}` : ''}`,
    )

    // Initialize git repo in the sandbox and sync with host
    try {
      if (branchNumber) {
        const sessionGit = new SessionGitManager(sandbox, this.repoPath, worktree, branchNumber)
        await sessionGit.initializeAndSync(pluginCtx)
      } else {
        // Git disabled; still ensure the directory exists so tools can operate.
        await new DaytonaSandboxGitManager(sandbox, this.repoPath).ensureDirectory()
      }
    } catch (err: any) {
      logger.error(`Failed to initialize git repo or push local changes in sandbox: ${err}`)
      toast.show({
        title: 'Git error',
        message: err?.message || 'Failed to initialize git repo in sandbox.',
        variant: 'error',
      })
    }
    // Deletion may have raced the initialization awaits above; the mapping was already
    // registered, so the delete flow owns (and removes) the sandbox itself - returning
    // it would hand callers a destroyed sandbox that fails confusingly on first use.
    this.ensureNotDeleted(sessionId)
    toast.show({
      title: 'Sandbox created',
      message: `Created new sandbox for session.`,
      variant: 'success',
    })
    return sandbox
  }

  /**
   * Delete the sandbox associated with the given session ID
   */
  async deleteSandbox(sessionId: string, projectId: string): Promise<boolean> {
    // Concurrent deletes share one promise: a second teardown racing the first would
    // observe the already-deleted sandbox, throw, and wrongly clear the tombstone.
    const inFlight = this.deletionPromises.get(sessionId)
    if (inFlight) return inFlight

    // Tombstone first, removed again on failure: while set, no code path may create or
    // reconnect a sandbox for this session. Kept after success on purpose - the session
    // is gone, and any late event for it must no-op instead of resurrecting a sandbox.
    this.deletingSessions.add(sessionId)
    const run = (async () => {
      try {
        return await this.deleteSandboxInner(sessionId, projectId)
      } catch (err) {
        this.deletingSessions.delete(sessionId)
        throw err
      } finally {
        this.deletionPromises.delete(sessionId)
      }
    })()
    this.deletionPromises.set(sessionId, run)
    return run
  }

  private async deleteSandboxInner(sessionId: string, projectId: string): Promise<boolean> {
    await SessionGitManager.waitForPendingSync(sessionId)

    let sandbox = this.sessionSandboxes.get(sessionId)

    // Read-only lookup so deleting never migrates sessions or rewrites project metadata.
    const stored = this.dataStorage.findSession(sessionId)

    let sandboxGone = false

    // If not in cache, try to load from storage and reconnect
    if (!sandbox || this.isPartiallyInitialized(sandbox)) {
      if (stored?.session.sandboxId) {
        const daytona = new Daytona({ apiKey: this.apiKey })
        try {
          sandbox = await daytona.get(stored.session.sandboxId)
          this.sessionSandboxes.set(sessionId, sandbox)
        } catch (err) {
          if (err instanceof DaytonaNotFoundError) {
            sandboxGone = true
            logger.warn(`Sandbox ${stored.session.sandboxId} no longer exists; clearing stale mapping.`)
          } else {
            // Non-404: we cannot confirm the sandbox is gone. Surface the error so the
            // event handler shows a "Delete failed" toast instead of silently reporting
            // success while leaving a running sandbox on the Daytona account.
            logger.error(`Failed to reconnect to sandbox ${stored.session.sandboxId}: ${err}`)
            throw err
          }
        }
      } else {
        sandboxGone = true
      }
    }

    // Delete the sandbox if we have a fully initialized one
    let deleted = false
    if (this.isFullyInitialized(sandbox)) {
      // Final sync and deletion run as ONE queue entry, so a sync enqueued between the
      // wait above and this point is drained first, and nothing can slot in between
      // pulling the last changes and destroying the sandbox.
      const target = sandbox
      await SessionGitManager.enqueueSessionSync(sessionId, async () => {
        await this.syncBeforeDelete(target, stored)
        logger.info(`Removing sandbox for session: ${sessionId}`)
        await target.delete()
      })
      deleted = true
      sandboxGone = true
      logger.info(`Sandbox deleted successfully.`)
    } else {
      logger.warn(`No sandbox found for session: ${sessionId}`)
    }

    // Clear the local mapping when the sandbox is gone (deleted or already absent) so a
    // stale entry can't cause repeated reconnect failures. Preserve it on transient errors.
    if (sandboxGone) {
      this.sessionSandboxes.delete(sessionId)
      const cleanupProjectId = stored?.projectId ?? projectId
      const cleanupWorktree = stored?.worktree ?? this.dataStorage.load(projectId)?.worktree ?? ''
      this.dataStorage.removeSession(cleanupProjectId, cleanupWorktree, sessionId)
    }

    return deleted
  }

  /**
   * Pull not-yet-synced sandbox changes into the local repo before the sandbox is
   * destroyed. Throws — aborting deletion so the sandbox is preserved — when unsynced
   * changes cannot be pulled, including when the local repository itself is no longer
   * accessible (a silent skip there would destroy the only copy of the work). A sandbox
   * that is not running is deleted without being started: anything in it was either
   * synced while it ran or is abandoned by the explicit delete.
   *
   * Runs inside the session's sync queue; it must NOT enqueue (that would deadlock).
   */
  private async syncBeforeDelete(sandbox: Sandbox, stored: { worktree: string; session: SessionInfo } | undefined) {
    const branchNumber = stored?.session.branchNumber
    if (!branchNumber || !stored?.worktree) return
    await sandbox.refreshData()
    if (sandbox.state !== 'started') return
    const sessionGit = new SessionGitManager(sandbox, this.repoPath, stored.worktree, branchNumber)
    if (!sessionGit.hasLocalRepo()) {
      throw new Error(
        `Local repository at ${stored.worktree} is not accessible, so unsynced sandbox changes cannot be pulled; the sandbox was not deleted. Restore the repository or delete the sandbox from the Daytona dashboard.`,
      )
    }
    try {
      await sessionGit.autoCommitAndPull()
    } catch (err: any) {
      throw new Error(
        `Sandbox has changes that could not be synced to the local repository; the sandbox was not deleted. ${err?.message ?? err}`,
      )
    }
  }

  /**
   * Read-only check for a session→sandbox mapping (memory or storage); never creates,
   * migrates, or connects.
   */
  hasSandbox(sessionId: string, projectId: string): boolean {
    if (this.deletingSessions.has(sessionId)) return false
    this.setProjectContext(projectId)
    if (this.sessionSandboxes.has(sessionId)) return true
    return this.dataStorage.findSession(sessionId) !== undefined
  }

  isSessionDeleting(sessionId: string): boolean {
    return this.deletingSessions.has(sessionId)
  }

  /**
   * Guard for registration points that follow an await: deletion may have started (and
   * finished) while a sandbox was being refreshed or reconnected, and persisting the
   * mapping afterwards would resurrect state for a session that no longer exists.
   */
  private ensureNotDeleted(sessionId: string): void {
    if (this.deletingSessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} was deleted while its sandbox was being prepared.`)
    }
  }
}
