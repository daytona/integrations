/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { logger } from '../core/logger'

export const DEFAULT_GATEWAY_HOST = 'ssh.app.daytona.io'
const DEFAULT_API_URL = 'https://app.daytona.io/api'
const SECURITY_POLICY_URL = 'https://github.com/daytona/.github/blob/main/SECURITY.md#ssh-host-key-verification'
const CONFIG_FETCH_TIMEOUT_MS = 5_000

export type GatewayEndpoint = { host: string; port: number }

/**
 * Which known_hosts file (if any) is the trust root for sandbox git transfers in this
 * process, and where it came from. Always the OUTPUT of resolution, never a user
 * input: there is no mode that disables host verification. The weakest outcome,
 * 'inherited', is the SSH client's own verification - the behavior before this existed.
 */
export type HostKeyVerification =
  | { mode: 'manual'; knownHostsFile: string; endpoint: GatewayEndpoint }
  | { mode: 'pinned'; knownHostsFile: string; endpoint: GatewayEndpoint; fingerprints: string[] }
  | { mode: 'inherited'; endpoint: GatewayEndpoint; reason: string }

type PublishedGateway = { host: string; port: number; hostKeys: string[] }

/**
 * Decides, once per process, how transfers to the SSH gateway verify its host key:
 *
 * 1. DAYTONA_SSH_KNOWN_HOSTS set  -> that file is the only trust root ("manual").
 * 2. Otherwise, unless DAYTONA_SSH_AUTO_PIN=false, the gateway host key published by the
 *    Daytona API (/config: sshGatewayHostKeys) is written to a plugin-managed known_hosts
 *    file and used as the only trust root ("pinned"). The API is consulted once per
 *    process; the pin file is what connections use, so an API outage after the first pin
 *    never weakens verification.
 * 3. If nothing can be pinned (older API, API unreachable, auto-pin disabled), transfers
 *    fall back to the SSH client's normal host verification ("inherited") - exactly the
 *    behavior before this feature existed.
 *
 * Pinning is fail-closed against change: if the API later publishes a key set that no
 * longer contains the pinned key, the pin is NOT replaced. Either the gateway rotated its
 * key (the security policy publishes old and new keys concurrently during a rotation, so
 * this should not happen for a healthy client) or something between the client and the
 * API is lying; only a human can tell, so transfers are refused until the pin file is
 * verified against the policy and removed.
 */
export class GatewayHostKeyPin {
  private resolved?: Promise<HostKeyVerification>

  constructor(
    private readonly storageDir: string,
    private readonly apiUrl: string = process.env.DAYTONA_API_URL?.trim() || DEFAULT_API_URL,
  ) {}

  get pinFile(): string {
    return join(this.storageDir, 'gateway_known_hosts')
  }

  resolve(): Promise<HostKeyVerification> {
    this.resolved ??= this.resolveOnce()
    return this.resolved
  }

  private async resolveOnce(): Promise<HostKeyVerification> {
    const manual = process.env.DAYTONA_SSH_KNOWN_HOSTS?.trim()
    const published = await this.fetchPublishedGateway()
    const endpoint: GatewayEndpoint = published
      ? { host: published.host, port: published.port }
      : { host: DEFAULT_GATEWAY_HOST, port: 22 }

    if (manual) {
      this.warnIfManualDisagrees(manual, published)
      return { mode: 'manual', knownHostsFile: manual, endpoint }
    }
    if (process.env.DAYTONA_SSH_AUTO_PIN?.trim().toLowerCase() === 'false') {
      return { mode: 'inherited', endpoint, reason: 'DAYTONA_SSH_AUTO_PIN=false' }
    }

    const existing = this.readPin()
    if (published) {
      const publishedEntries = published.hostKeys.map((key) => knownHostsEntry(endpoint, key))
      if (existing && !existing.entries.some((entry) => publishedEntries.includes(entry))) {
        const message =
          `The SSH gateway host key published by ${this.apiUrl}/config no longer matches the key pinned in ${this.pinFile}. ` +
          `Either the gateway rotated its key and this machine has not synced since before the rotation's overlap window ` +
          `(the security policy publishes old and new keys together for at least 30 days), or something between this machine and the API is not Daytona. ` +
          `Verify the published fingerprint against ${SECURITY_POLICY_URL}; if it matches, run \`rm ${this.pinFile}\` and sync again to pin the new key.`
        logger.error(`[host-key] ${message}`)
        throw new Error(message)
      }
      if (!existing || existing.entries.length !== publishedEntries.length || publishedEntries.some((e) => !existing.entries.includes(e))) {
        this.writePin(publishedEntries)
        logger.info(
          `[host-key] pinned ${published.host}:${published.port} host key(s) ${fingerprintsOf(published.hostKeys).join(', ')} from ${this.apiUrl}/config`,
        )
      }
      return { mode: 'pinned', knownHostsFile: this.pinFile, endpoint, fingerprints: fingerprintsOf(published.hostKeys) }
    }

    if (existing) {
      logger.warn(`[host-key] ${this.apiUrl}/config did not provide a gateway host key; using the existing pin in ${this.pinFile}`)
      return { mode: 'pinned', knownHostsFile: this.pinFile, endpoint, fingerprints: fingerprintsOf(existing.entries.map(keyOfEntry)) }
    }
    logger.warn(
      `[host-key] no gateway host key is published by ${this.apiUrl}/config and none is pinned; falling back to the SSH client's own host verification. ` +
        `For strict noninteractive verification set DAYTONA_SSH_KNOWN_HOSTS (see ${SECURITY_POLICY_URL}).`,
    )
    return { mode: 'inherited', endpoint, reason: 'no published or pinned host key' }
  }

  private async fetchPublishedGateway(): Promise<PublishedGateway | undefined> {
    try {
      const response = await fetch(`${this.apiUrl.replace(/\/+$/, '')}/config`, {
        signal: AbortSignal.timeout(CONFIG_FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        logger.warn(`[host-key] ${this.apiUrl}/config returned HTTP ${response.status}`)
        return undefined
      }
      const body = (await response.json()) as Record<string, unknown>
      const hostKeys = Array.isArray(body.sshGatewayHostKeys) ? body.sshGatewayHostKeys.filter(isValidKeyLine) : []
      if (hostKeys.length === 0) return undefined
      const host = typeof body.sshGatewayHost === 'string' && /^[A-Za-z0-9.\-[\]:]+$/.test(body.sshGatewayHost) ? body.sshGatewayHost : DEFAULT_GATEWAY_HOST
      const port = typeof body.sshGatewayPort === 'number' && body.sshGatewayPort >= 1 && body.sshGatewayPort <= 65535 ? body.sshGatewayPort : 22
      return { host, port, hostKeys }
    } catch (err) {
      logger.warn(`[host-key] could not fetch ${this.apiUrl}/config: ${err}`)
      return undefined
    }
  }

  private warnIfManualDisagrees(manualFile: string, published: PublishedGateway | undefined): void {
    if (!published || !existsSync(manualFile)) return
    try {
      const manualKeys = readFileSync(manualFile, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map(keyOfEntry)
      if (!manualKeys.some((key) => published.hostKeys.includes(key))) {
        logger.warn(
          `[host-key] DAYTONA_SSH_KNOWN_HOSTS (${manualFile}) contains none of the host keys published by ${this.apiUrl}/config (${fingerprintsOf(published.hostKeys).join(', ')}). ` +
            `The manual file is still used as configured; verify both against ${SECURITY_POLICY_URL}.`,
        )
      }
    } catch (err) {
      logger.warn(`[host-key] could not read DAYTONA_SSH_KNOWN_HOSTS for comparison: ${err}`)
    }
  }

  private readPin(): { entries: string[] } | undefined {
    if (!existsSync(this.pinFile)) return undefined
    const entries = readFileSync(this.pinFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    return entries.length ? { entries } : undefined
  }

  private writePin(entries: string[]): void {
    mkdirSync(this.storageDir, { recursive: true })
    const tmp = `${this.pinFile}.${process.pid}.tmp`
    writeFileSync(tmp, entries.join('\n') + '\n', { mode: 0o600 })
    try {
      renameSync(tmp, this.pinFile)
    } catch {
      writeFileSync(this.pinFile, entries.join('\n') + '\n', { mode: 0o600 })
    } finally {
      try {
        rmSync(tmp, { force: true })
      } catch {}
    }
  }
}

/** OpenSSH known_hosts host field: bare host on port 22, `[host]:port` otherwise. */
export function knownHostsHost(endpoint: GatewayEndpoint): string {
  return endpoint.port === 22 ? endpoint.host : `[${endpoint.host}]:${endpoint.port}`
}

function knownHostsEntry(endpoint: GatewayEndpoint, keyLine: string): string {
  const [type, blob] = keyLine.trim().split(/\s+/)
  return `${knownHostsHost(endpoint)} ${type} ${blob}`
}

function keyOfEntry(entry: string): string {
  const parts = entry.trim().split(/\s+/)
  return `${parts[1]} ${parts[2]}`
}

// Accept only what OpenSSH will load as a host key line; the API validates on its side
// too, but this is the trust boundary on ours.
function isValidKeyLine(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = value.trim().split(/\s+/)
  if (parts.length < 2 || !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$/.test(parts[0])) return false
  if (!/^[A-Za-z0-9+/]+=*$/.test(parts[1])) return false
  try {
    execFileSync('ssh-keygen', ['-lf', '-'], { input: `${parts[0]} ${parts[1]}\n`, stdio: ['pipe', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

function fingerprintsOf(keyLines: string[]): string[] {
  return keyLines.map((line) => {
    try {
      return execFileSync('ssh-keygen', ['-lf', '-'], { input: `${line}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
        .trim()
        .split(/\s+/)[1]
    } catch {
      return 'unknown'
    }
  })
}
