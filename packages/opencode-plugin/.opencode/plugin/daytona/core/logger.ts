/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Logger class for handling plugin logging
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { LogLevel } from './types'
import { LOG_LEVEL_INFO, LOG_LEVEL_ERROR, LOG_LEVEL_WARN } from './types'

let logFilePath: string | undefined

export function setLogFilePath(path: string) {
  logFilePath = path
  sanitizeExistingLog(path)
}

// Earlier plugin versions wrote credential-bearing sandbox URLs to this file, and log
// rotation only trims by size, so those lines would otherwise persist indefinitely.
// Rewrite the file once in place with the same redaction applied to new entries.
function sanitizeExistingLog(path: string): void {
  let tmpPath: string | undefined
  try {
    if (!existsSync(path)) return
    const current = readFileSync(path, 'utf8')
    const cleaned = redactCredentials(current)
    if (cleaned === current) return
    tmpPath = `${path}.${process.pid}.tmp`
    writeFileSync(tmpPath, cleaned)
    // rename replaces an existing target on every platform Node supports; the one case
    // it cannot handle (Windows, target held open by another process) falls through to
    // the in-place overwrite below rather than leaving the credentials in the file.
    try {
      renameSync(tmpPath, path)
    } catch {
      writeFileSync(path, cleaned)
      rmSync(tmpPath, { force: true })
    }
  } catch {
    // Best effort: a sanitize failure must never prevent the plugin from loading.
    if (tmpPath) rmSync(tmpPath, { force: true })
  }
}

// Defense in depth for the durable log file: the plugin never builds credential-bearing
// URLs or logs its GIT_SSH_COMMAND, but git/ssh error output is logged verbatim, so
// strip anything shaped like SSH URL userinfo or an ssh `User=` option before writing.
export function redactCredentials(message: string): string {
  return message.replace(/(ssh:\/\/)[^@\s/]+@/g, '$1***@').replace(/(\bUser=)['"]?[^'"\s]+/g, '$1***')
}

class Logger {
  private get logFile() {
    if (!logFilePath) throw new Error('Logger file path not set. Call setLogFilePath(path) before use.')
    return logFilePath
  }

  log(message: string, level: LogLevel = LOG_LEVEL_INFO): void {
    // Ensure log directory exists
    try {
      mkdirSync(dirname(this.logFile), { recursive: true })
    } catch (err) {
      // Directory may already exist, ignore
    }
    // Trim by byte length (not characters) so the 1MB target holds for non-ASCII logs
    try {
      const stats = statSync(this.logFile)
      const maxSize = 3 * 1024 * 1024
      const keepSize = 1024 * 1024
      if (stats.size > maxSize) {
        const buffer = readFileSync(this.logFile)
        const trimmed = buffer.subarray(buffer.length - keepSize)
        // Drop partial first line so we don't start mid-log
        const firstNewline = trimmed.indexOf('\n')
        writeFileSync(this.logFile, firstNewline >= 0 ? trimmed.subarray(firstNewline + 1) : trimmed)
      }
    } catch (err) {
      // File may not exist yet, ignore
    }
    const timestamp = new Date().toISOString()
    const logEntry = `[${timestamp}] [${level}] ${redactCredentials(message)}\n`
    try {
      appendFileSync(this.logFile, logEntry)
    } catch (err) {
      // Best-effort logging: never let a write failure crash the caller
    }
  }

  info(message: string): void {
    this.log(message, LOG_LEVEL_INFO)
  }

  error(message: string): void {
    this.log(message, LOG_LEVEL_ERROR)
  }

  warn(message: string): void {
    this.log(message, LOG_LEVEL_WARN)
  }
}

export const logger = new Logger()
