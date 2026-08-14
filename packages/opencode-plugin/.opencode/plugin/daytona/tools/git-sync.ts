/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { DaytonaSessionManager } from '../core/session-manager'
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
    const sandbox = await sessionManager.getSandbox(sessionId, projectId, worktree, pluginCtx)
    const branchNumber = sessionManager.getBranchNumberForSandbox(projectId, sandbox.id)
    if (!branchNumber) {
      return 'Git syncing is disabled for this session (no local git repository); nothing to sync.'
    }
    const sessionGit = new SessionGitManager(sandbox, sessionManager.repoPath, worktree, branchNumber)
    const didSync = await SessionGitManager.enqueueSessionSync(sessionId, () => sessionGit.autoCommitAndPull(pluginCtx))
    return didSync
      ? `Synced sandbox changes to local branch opencode/${branchNumber}.`
      : 'No changes to sync; the local repository is already up to date.'
  },
})
