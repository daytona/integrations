/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Handles file storage operations for project session data
 * Stores data per-project in ~/.local/share/opencode/storage/daytona/{projectId}.json
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'fs'
import { join } from 'path'
import { logger } from './logger'
import type { GitReturnState, ProjectSessionData, SessionInfo } from './types'

export class ProjectDataStorage {
  private readonly storageDir: string

  constructor(storageDir: string) {
    this.storageDir = storageDir

    // Ensure storage directory exists
    if (!existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true })
    }
  }

  /**
   * Get the file path for a project's session data.
   * encodeURIComponent gives a reversible, collision-free encoding that also
   * strips path separators, so a projectId can't traverse outside storageDir
   * and distinct ids can't collide onto the same file.
   */
  private getProjectFilePath(projectId: string): string {
    return join(this.storageDir, `${encodeURIComponent(projectId)}.json`)
  }

  /**
   * List known project IDs from storage, decoded to the canonical form used by callers.
   * Filenames that can't be decoded (e.g. hand-created files with invalid percent escapes)
   * are skipped: exposing them would return an id that can't round-trip through
   * getProjectFilePath, causing subsequent load/save/remove to silently target the wrong file.
   */
  private listProjectIds(): string[] {
    try {
      const ids: string[] = []
      for (const name of readdirSync(this.storageDir)) {
        if (!name.endsWith('.json')) continue
        const encoded = name.slice(0, -'.json'.length)
        try {
          ids.push(decodeURIComponent(encoded))
        } catch {
          logger.warn(`Skipping project data file with undecodable name: ${name}`)
        }
      }
      return ids
    } catch (err) {
      logger.error(`Failed to list project data files: ${err}`)
      return []
    }
  }

  /**
   * Load project session data from disk
   */
  load(projectId: string): ProjectSessionData | null {
    const filePath = this.getProjectFilePath(projectId)
    try {
      if (existsSync(filePath)) {
        return JSON.parse(readFileSync(filePath, 'utf-8')) as ProjectSessionData
      }
    } catch (err) {
      logger.error(`Failed to load project data for ${projectId}: ${err}`)
    }
    return null
  }

  /**
   * Get a session for a project. If not found in the requested project, search all other
   * projects on disk and, if found, migrate it into the requested project.
   */
  getSession(projectId: string, worktree: string, sessionId: string): SessionInfo | undefined {
    const current = this.load(projectId)
    const currentSession = current?.sessions?.[sessionId]
    if (currentSession) {
      return currentSession
    }

    // Look in other projects and migrate if found.
    for (const otherProjectId of this.listProjectIds()) {
      if (otherProjectId === projectId) continue
      if (!this.load(otherProjectId)?.sessions?.[sessionId]) continue
      const migrated = this.migrateSession(projectId, worktree, sessionId, otherProjectId)
      if (migrated) return migrated
    }

    return undefined
  }

  /**
   * Move a session record between project files without ever destroying data that was
   * not copied, and without ever leaving a stale destination copy that would shadow a
   * newer source record on subsequent reads (getSession/findSession consult the
   * destination first). Each file is re-read and modified under its own lock,
   * destination and source in sequence, never nested.
   *
   * The snapshot is taken under the source lock; cleanup deletes the source record only
   * while it still equals that snapshot. If the source changed, the copy is retried
   * from the newer record; if it keeps changing, our destination copy is withdrawn so
   * the newest source record stays the single authoritative one, and migration is
   * retried on the next access. Both removals are conditional — source cleanup and
   * destination withdrawal each delete only a record still byte-identical to what this
   * migration copied — so a concurrent update on either side is never destroyed.
   * Cleanup ERRORS (as opposed to races) keep the old best-effort semantics: the
   * duplicate they leave is byte-identical, hence harmless.
   */
  private migrateSession(
    projectId: string,
    worktree: string,
    sessionId: string,
    otherProjectId: string,
  ): SessionInfo | undefined {
    let lastCopied: SessionInfo | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      let found: SessionInfo | undefined
      this.withFileLock(otherProjectId, () => {
        found = this.load(otherProjectId)?.sessions?.[sessionId]
      })
      if (!found) return undefined
      const snapshot = found

      // Write the destination first and confirm it landed on disk, so a write
      // failure can never delete the source before the copy is safely persisted.
      this.withFileLock(projectId, () => {
        const destination: ProjectSessionData = this.load(projectId) ?? {
          projectId,
          worktree,
          sessions: {},
        }
        destination.sessions[sessionId] = snapshot
        // Prefer the worktree for the project we're actually operating on.
        destination.worktree = worktree
        this.save(projectId, destination)
      })
      lastCopied = snapshot

      if (!this.load(projectId)?.sessions?.[sessionId]) {
        logger.error(`Migration of session ${sessionId} to project ${projectId} did not persist; leaving source intact`)
        return snapshot
      }

      let cleaned = false
      try {
        this.withFileLock(otherProjectId, () => {
          const source = this.load(otherProjectId)
          const currentRecord = source?.sessions?.[sessionId]
          if (!source || !currentRecord) {
            cleaned = true
            return
          }
          if (JSON.stringify(currentRecord) === JSON.stringify(snapshot)) {
            delete source.sessions[sessionId]
            this.save(otherProjectId, source)
            cleaned = true
          }
        })
      } catch (err) {
        logger.warn(`Failed to remove session ${sessionId} from project ${otherProjectId}: ${err}`)
        cleaned = true
      }

      if (cleaned) {
        logger.info(`Migrated session ${sessionId} from project ${otherProjectId} to project ${projectId}`)
        return snapshot
      }
      logger.warn(
        `Session ${sessionId} changed in project ${otherProjectId} during migration; retrying from the newer record`,
      )
    }

    // The source kept changing while we copied: withdraw our stale destination copy so
    // the newest source record cannot be shadowed, and let a later access re-migrate.
    // Compare-and-withdraw, mirroring the source cleanup: only OUR copy is removed. If
    // another instance updated the destination record after our last copy, that record
    // is newer than anything we hold, so it stays and is returned to the caller.
    let survivingDestination: SessionInfo | undefined
    this.withFileLock(projectId, () => {
      const destination = this.load(projectId)
      const currentRecord = destination?.sessions?.[sessionId]
      if (!destination || !currentRecord) return
      if (JSON.stringify(currentRecord) !== JSON.stringify(lastCopied)) {
        survivingDestination = currentRecord
        return
      }
      delete destination.sessions[sessionId]
      this.save(projectId, destination)
    })
    if (survivingDestination) {
      logger.warn(
        `Session ${sessionId} was updated in project ${projectId} after the migration copy; keeping that record instead of withdrawing it`,
      )
      return survivingDestination
    }
    logger.warn(
      `Migration of session ${sessionId} from project ${otherProjectId} withdrawn after repeated concurrent updates; will retry on next access`,
    )
    return this.load(otherProjectId)?.sessions?.[sessionId]
  }

  /**
   * Read-only lookup of a session across all project files. Unlike getSession, this never
   * migrates or writes, so it is safe to use on the delete path.
   */
  findSession(sessionId: string): { projectId: string; worktree: string; session: SessionInfo } | undefined {
    for (const projectId of this.listProjectIds()) {
      const data = this.load(projectId)
      const session = data?.sessions?.[sessionId]
      if (session && data) {
        // Return the filename-derived projectId (the value that maps back to the file we
        // just loaded), NOT data.projectId. The delete cleanup path passes this value to
        // removeSession → load → getProjectFilePath; if we returned the raw canonical id
        // and it doesn't round-trip identically (e.g. legacy files with a different
        // sanitization scheme), the cleanup would silently target a different file and
        // leave the stale mapping behind.
        //
        // Prefer the session's own worktree: the project-level field is overwritten by
        // whichever session touched the project last, which in linked-worktree setups
        // can be a DIFFERENT checkout than the one this session runs in. Project-level
        // remains as fallback for storage files written by older plugin versions.
        return { projectId, worktree: session.worktree ?? data.worktree, session }
      }
    }
    return undefined
  }

  /**
   * Save project session data to disk.
   *
   * `storageKey` identifies WHICH FILE on disk to write (round-trips through
   * getProjectFilePath). `projectData.projectId` is the CANONICAL id written into
   * the JSON body — kept separate so callers who reached a file via a filename-derived
   * key (e.g. findSession → removeSession for legacy files) don't clobber the
   * pre-existing canonical id with the storage key.
   */
  save(storageKey: string, projectData: ProjectSessionData): void {
    const filePath = this.getProjectFilePath(storageKey)
    try {
      // Write-to-temp + rename so a crash mid-write can never leave a torn JSON file.
      const tmpPath = `${filePath}.${process.pid}.tmp`
      writeFileSync(tmpPath, JSON.stringify(projectData, null, 2))
      renameSync(tmpPath, filePath)
      logger.info(`Saved project data for ${projectData.projectId}`)
    } catch (err) {
      logger.error(`Failed to save project data for ${projectData.projectId} at ${filePath}: ${err}`)
    }
  }

  /**
   * Run a read-modify-write against a project file while holding a cross-process lock,
   * so two OpenCode instances sharing a project cannot overwrite each other's session
   * updates (each save replaces the whole file). Within one process the storage methods
   * are synchronous, so this only guards against OTHER processes. Locks from crashed
   * processes are stolen after 5s; if the lock cannot be acquired within 6s we proceed
   * unlocked (availability over strictness) with a warning.
   */
  private withFileLock<T>(storageKey: string, fn: () => T): T {
    const lockPath = `${this.getProjectFilePath(storageKey)}.lock`
    const deadline = Date.now() + 6000
    let locked = false
    while (Date.now() < deadline) {
      try {
        const fd = openSync(lockPath, 'wx')
        try {
          writeSync(fd, String(process.pid))
        } finally {
          closeSync(fd)
        }
        locked = true
        break
      } catch {
        try {
          // Steal only when stale AND the recorded owner is confirmed dead (signal 0
          // probes liveness without signalling). A live-but-slow holder keeps its lock;
          // we wait out the deadline instead of running concurrently with it.
          if (Date.now() - statSync(lockPath).mtimeMs > 5000 && !this.isPidAlive(readFileSync(lockPath, 'utf8'))) {
            rmSync(lockPath, { force: true })
            continue
          }
        } catch {
          continue
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    if (!locked) logger.warn(`Proceeding without storage lock for ${storageKey}; lock at ${lockPath} never freed`)
    try {
      return fn()
    } finally {
      if (locked) rmSync(lockPath, { force: true })
    }
  }

  private isPidAlive(rawPid: string): boolean {
    const pid = Number.parseInt(rawPid.trim(), 10)
    if (!Number.isFinite(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (err: any) {
      // EPERM means the process exists but belongs to another user.
      return err?.code === 'EPERM'
    }
  }

  /**
   * Get branch number for a sandbox
   */
  getBranchNumberForSandbox(projectId: string, sandboxId: string): number | undefined {
    const projectData = this.load(projectId)
    if (!projectData) {
      return undefined
    }
    const session = Object.values(projectData.sessions).find((s) => s.sandboxId === sandboxId)
    return session?.branchNumber
  }

  /**
   * Update a single session in the project file
   */
  updateSession(
    projectId: string,
    worktree: string,
    sessionId: string,
    sandboxId: string,
    branchNumber?: number,
  ): void {
    this.withFileLock(projectId, () => {
      const projectData = this.load(projectId) || {
        projectId,
        worktree,
        sessions: {},
      }

      const now = Date.now()
      if (!projectData.sessions[sessionId]) {
        projectData.sessions[sessionId] = {
          sandboxId,
          ...(branchNumber !== undefined ? { branchNumber } : {}),
          worktree,
          created: now,
          lastAccessed: now,
        }
      } else {
        projectData.sessions[sessionId].sandboxId = sandboxId
        projectData.sessions[sessionId].lastAccessed = now
        projectData.sessions[sessionId].worktree = worktree
        // Only update branch number if it wasn't set before
        if (projectData.sessions[sessionId].branchNumber === undefined) {
          if (branchNumber !== undefined) {
            projectData.sessions[sessionId].branchNumber = branchNumber
          }
        }
      }

      // Refresh worktree from the current call (state that can change over time), but
      // NEVER refresh projectData.projectId — that's identity, set at creation, and
      // preserving it is the whole point of save()'s two-parameter API.
      projectData.worktree = worktree
      this.save(projectId, projectData)
    })
  }

  /**
   * Record the git-return state for a session, wherever its project file lives.
   * No-ops when the session is unknown (e.g. already removed by deletion).
   */
  recordGitReturn(sessionId: string, state: GitReturnState, message?: string): void {
    const found = this.findSession(sessionId)
    if (!found) return
    this.withFileLock(found.projectId, () => {
      const projectData = this.load(found.projectId)
      const session = projectData?.sessions?.[sessionId]
      if (!projectData || !session) return
      session.gitReturn = { state, ...(message !== undefined ? { message } : {}), updatedAt: Date.now() }
      this.save(found.projectId, projectData)
    })
  }

  /**
   * Remove a session from the project file
   */
  removeSession(projectId: string, worktree: string, sessionId: string): void {
    this.withFileLock(projectId, () => {
      const projectData = this.load(projectId)
      if (projectData && projectData.sessions[sessionId]) {
        delete projectData.sessions[sessionId]
        this.save(projectId, projectData)
      }
    })
  }
}
