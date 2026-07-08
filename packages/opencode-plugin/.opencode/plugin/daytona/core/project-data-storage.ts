/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Handles file storage operations for project session data
 * Stores data per-project in ~/.local/share/opencode/storage/daytona/{projectId}.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { logger } from './logger'
import type { ProjectSessionData, SessionInfo } from './types'

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

      const otherData = this.load(otherProjectId)
      const found = otherData?.sessions?.[sessionId]
      if (!found) continue

      const destination: ProjectSessionData = current ?? {
        projectId,
        worktree,
        sessions: {},
      }

      // Write the destination first and confirm it landed on disk, so a write
      // failure can never delete the source before the copy is safely persisted.
      destination.sessions[sessionId] = found
      // Prefer the worktree for the project we're actually operating on.
      destination.worktree = worktree
      this.save(projectId, destination.worktree, destination.sessions)

      if (!this.load(projectId)?.sessions?.[sessionId]) {
        logger.error(`Migration of session ${sessionId} to project ${projectId} did not persist; leaving source intact`)
        return found
      }

      // Destination is safe; now remove from the source (best effort).
      try {
        delete otherData!.sessions[sessionId]
        this.save(otherProjectId, otherData!.worktree, otherData!.sessions)
      } catch (err) {
        logger.warn(`Failed to remove session ${sessionId} from project ${otherProjectId}: ${err}`)
      }

      logger.info(`Migrated session ${sessionId} from project ${otherProjectId} to project ${projectId}`)
      return found
    }

    return undefined
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
        return { projectId, worktree: data.worktree, session }
      }
    }
    return undefined
  }

  /**
   * Save project session data to disk
   */
  save(projectId: string, worktree: string, sessions: Record<string, SessionInfo>): void {
    const filePath = this.getProjectFilePath(projectId)
    const projectData: ProjectSessionData = {
      projectId,
      worktree,
      sessions,
    }

    try {
      writeFileSync(filePath, JSON.stringify(projectData, null, 2))
      logger.info(`Saved project data for ${projectId}`)
    } catch (err) {
      logger.error(`Failed to save project data for ${projectId}: ${err}`)
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
        created: now,
        lastAccessed: now,
      }
    } else {
      projectData.sessions[sessionId].sandboxId = sandboxId
      projectData.sessions[sessionId].lastAccessed = now
      // Only update branch number if it wasn't set before
      if (projectData.sessions[sessionId].branchNumber === undefined) {
        if (branchNumber !== undefined) {
          projectData.sessions[sessionId].branchNumber = branchNumber
        }
      }
    }

    this.save(projectId, worktree, projectData.sessions)
  }

  /**
   * Remove a session from the project file
   */
  removeSession(projectId: string, worktree: string, sessionId: string): void {
    const projectData = this.load(projectId)
    if (projectData && projectData.sessions[sessionId]) {
      delete projectData.sessions[sessionId]
      this.save(projectId, worktree, projectData.sessions)
    }
  }
}
