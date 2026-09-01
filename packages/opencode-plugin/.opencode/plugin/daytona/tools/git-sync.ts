/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { DaytonaSessionManager } from '../core/session-manager'
import type { GitReturnStatus } from '../core/types'
import { SessionGitManager } from '../git/session-git-manager'

export const gitSyncTool = (
  sessionManager: DaytonaSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description:
    'Commits pending changes in the Daytona sandbox and pulls them into the local opencode/N branch. Returns only after the changes are in the local repository, and fails with the git error otherwise. Use as the final step when the user asks to sync, hand off, or finalize sandbox changes.',
  args: {},
  async execute(_args: {}, ctx: ToolContext) {
    const sessionId = ctx.sessionID
    if (!sessionManager.hasSandbox(sessionId, projectId)) {
      return 'No sandbox exists for this session; nothing to sync.'
    }
    try {
      const sandbox = await sessionManager.getSandbox(sessionId, projectId, worktree, pluginCtx)
      const branchNumber = sessionManager.getBranchNumberForSandbox(projectId, sandbox.id)
      if (!branchNumber) {
        // A missing branch number means "no repo, syncing intentionally off" ONLY when
        // the worktree really has no repo. With a healthy repo it means branch
        // allocation failed earlier - a broken return path, not a disabled one.
        if (SessionGitManager.hasRepo(worktree)) {
          const message =
            'no sync branch was allocated for this session even though a local repository exists; recreate the session to re-enable syncing'
          sessionManager.recordGitReturn(sessionId, 'failed', message)
          throw new Error(`Cannot sync: ${message}.`)
        }
        sessionManager.recordGitReturn(sessionId, 'disabled', 'no local git repository; syncing is disabled')
        return 'Git syncing is disabled for this session (no local git repository); nothing to sync.'
      }
      const sessionGit = new SessionGitManager(sandbox, sessionManager.repoPath, worktree, branchNumber)
      // Read inside the queue entry, after queued syncs have settled, so the note
      // reflects a failure they persisted while this call was waiting its turn.
      let previous: GitReturnStatus | undefined
      const didSync = await SessionGitManager.enqueueSessionSync(sessionId, () => {
        previous = sessionManager.getGitReturn(sessionId)
        return sessionGit.autoCommitAndPull(pluginCtx)
      })
      const note =
        previous?.state === 'setup-failed'
          ? `Warning: the initial git setup for this sandbox failed (${previous.message ?? 'unknown error'}), so the synced branch may not share history with your local HEAD. `
          : previous?.state === 'failed'
            ? `Note: the last sync attempt failed (${previous.message ?? 'unknown error'}); retried now. `
            : ''
      sessionManager.recordGitReturn(
        sessionId,
        'synced',
        didSync ? 'changes pulled into the local repository' : 'no changes to sync',
      )
      return (
        note +
        (didSync
          ? `Synced sandbox changes to local branch opencode/${branchNumber}.`
          : 'No changes to sync; the local repository is already up to date.')
      )
    } catch (err: any) {
      sessionManager.recordGitReturn(sessionId, 'failed', String(err?.message ?? err))
      throw err
    }
  },
})
