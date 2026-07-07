/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Logger class for handling plugin logging
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { LogLevel } from './types'
import { LOG_LEVEL_INFO, LOG_LEVEL_ERROR, LOG_LEVEL_WARN } from './types'

let logFilePath: string | undefined

export function setLogFilePath(path: string) {
  logFilePath = path
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
    const logEntry = `[${timestamp}] [${level}] ${message}\n`
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
