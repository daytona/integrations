/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenCode Plugin: Daytona Sandbox Integration
 *
 * OpenCode plugins extend the AI coding assistant by adding custom tools, handling events,
 * and modifying behavior. Plugins are TypeScript/JavaScript modules that export functions
 * which return hooks for various lifecycle events.
 *
 * This plugin integrates Daytona sandboxes with OpenCode, providing isolated development
 * environments for each session. It adds custom tools for file operations, command execution,
 * and search within sandboxes, and automatically cleans up resources when sessions end.
 *
 * Learn more: https://opencode.ai/docs/plugins/
 *
 * Daytona Sandbox Integration Tools
 *
 * Requires:
 * - npm install @daytona/sdk
 * - Environment: DAYTONA_API_KEY
 * - Environment (optional): DAYTONA_SNAPSHOT - snapshot to create sandboxes from
 */

import { join } from 'path'
import { homedir } from 'os'
import { xdgData } from 'xdg-basedir'
import type { PluginInput } from '@opencode-ai/plugin'
import { logger, setLogFilePath } from './core/logger'
import { DaytonaSessionManager } from './core/session-manager'
import { SessionGitManager } from './git/session-git-manager'
import { toast } from './core/toast'
import { customTools } from './plugins/custom-tools'
import { eventHandlers } from './plugins/session-events'
import { systemPromptTransform } from './plugins/system-transform'

export type { EventSessionDeleted, LogLevel, SandboxInfo, SessionInfo, ProjectSessionData } from './core/types'

const xdgDataDir = xdgData ?? join(homedir(), '.local', 'share')
const LOG_FILE = join(xdgDataDir, 'opencode', 'log', 'daytona.log')
const STORAGE_DIR = join(xdgDataDir, 'opencode', 'storage', 'daytona')
const REPO_PATH = '/home/daytona/project'

setLogFilePath(LOG_FILE)
const sessionManager = new DaytonaSessionManager(
  process.env.DAYTONA_API_KEY || '',
  STORAGE_DIR,
  REPO_PATH,
  process.env.DAYTONA_SNAPSHOT,
)

async function daytonaPlugin(ctx: PluginInput) {
  toast.initialize(ctx.client?.tui)
  return {
    tool: await customTools(ctx, sessionManager),
    event: await eventHandlers(ctx, sessionManager, REPO_PATH),
    'experimental.chat.system.transform': await systemPromptTransform(ctx, REPO_PATH),
    // Awaited by OpenCode when the plugin scope closes (newer than the published Hooks
    // type, ignored by older versions). Draining here keeps a graceful shutdown from
    // abandoning a git sync that the unawaited `event` hook started on session.idle.
    // Bounded so a sync stalled on an unreachable sandbox cannot wedge process exit.
    dispose: async () => {
      const drained = await SessionGitManager.waitForAllPendingSyncs(60_000)
      if (!drained) {
        logger.warn('[dispose] exiting with git syncs still pending after 60s; a sync may be stalled')
      }
    },
  }
}

export default daytonaPlugin
