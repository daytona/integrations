/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Covers DAYTONA_SNAPSHOT, the env var selecting which Daytona snapshot new
 * workspace sandboxes are created from.
 *
 *   - configured snapshot: the created sandbox reports exactly that snapshot.
 *     TEST_SNAPSHOT is deliberately not the snapshot Daytona picks on its own,
 *     so this can only pass if the value flowed through the adapter into
 *     d.create().
 *   - unresolvable snapshot: create fails loudly instead of silently falling
 *     back to the default. Fails before Daytona allocates anything, so it
 *     costs no sandbox.
 *
 * Requires DAYTONA_API_KEY (skipped otherwise). Creates exactly one sandbox.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, ChildProcess } from 'node:child_process'
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { Daytona } from '@daytona/sdk'

const OPENCODE_BIN = process.env.OPENCODE_BIN || resolve(import.meta.dir, '../node_modules/.bin/opencode')
const HAS_DAYTONA_KEY = Boolean(process.env.DAYTONA_API_KEY)

const PLUGIN_PATH = resolve(import.meta.dir, '../.opencode/plugin/index.ts')
const PLUGIN_SPEC = `file://${PLUGIN_PATH}`

// The plugin's debug log: records every workspace it starts building, which is
// the only reliable cleanup record when a create fails before returning a name.
const PLUGIN_LOG = '/tmp/daytona-plugin.log'

// Must match the branch the test repo is pinned to: the plugin clones with
// --branch, so a mismatch fails create for reasons unrelated to snapshots.
const TEST_BRANCH = 'main'

// Daytona-provided, so it exists in any org; override if yours removed it.
const TEST_SNAPSHOT = process.env.DAYTONA_TEST_SNAPSHOT || 'daytona-small'
const NONEXISTENT_SNAPSHOT = 'opencode-plugin-test-no-such-snapshot'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readLog(): Promise<string> {
  return await readFile(PLUGIN_LOG, 'utf8').catch(() => '')
}

// Every sandbox the plugin began building since `offset`, whether or not the
// create call returned.
function sandboxNamesSince(log: string, offset: number): string[] {
  return [...log.slice(offset).matchAll(/create: start name=(\S+)/g)].map((m) => `opencode-${m[1]}`)
}

// Pick an OS-assigned free port so concurrent opencode servers don't collide.
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (typeof addr !== 'object' || addr === null) {
        srv.close()
        reject(new Error('failed to obtain port'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}

async function spawnAsync(cmd: string[], options: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd[0], cmd.slice(1), { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('close', (code: number | null) => {
      if (code === 0) resolve()
      else reject(new Error(stderr || `Exit code ${code}`))
    })
    proc.on('error', reject)
  })
}

async function waitForServer(port: number, maxWait = 60000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    try {
      // Per-request timeout: under bun's test runner a fetch to the child
      // opencode server can hang even though the server is healthy, wedging the
      // loop. AbortSignal.timeout makes it reject so the loop actually retries.
      const res = await fetch(`http://127.0.0.1:${port}/global/health`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) return true
    } catch {
      // Server not ready yet
    }
    await sleep(500)
  }
  return false
}

async function createTestProject(baseDir: string): Promise<string> {
  const projectDir = join(baseDir, 'test-project')
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, 'README.md'), '# Snapshot Test Project\n')

  await spawnAsync(['git', 'init'], { cwd: projectDir })
  await spawnAsync(['git', 'config', 'user.email', 'test@test.com'], { cwd: projectDir })
  await spawnAsync(['git', 'config', 'user.name', 'Test'], { cwd: projectDir })
  await spawnAsync(['git', 'add', '-A'], { cwd: projectDir })
  await spawnAsync(['git', 'commit', '-m', 'init'], { cwd: projectDir })
  // Force the branch name rather than inheriting the host's init.defaultBranch,
  // which varies between git versions.
  await spawnAsync(['git', 'branch', '-M', TEST_BRANCH], { cwd: projectDir })

  await writeFile(
    join(projectDir, 'opencode.json'),
    JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugin: [PLUGIN_SPEC] }, null, 2),
  )
  return projectDir
}

// The plugin reads DAYTONA_SNAPSHOT from the server process's environment, so
// each case runs against its own opencode server.
async function withServer(cwd: string, snapshot: string, fn: (port: number) => Promise<void>): Promise<void> {
  const port = await freePort()
  let proc: ChildProcess | null = null
  try {
    proc = spawn(OPENCODE_BIN, ['serve', '--port', String(port)], {
      cwd,
      env: { ...process.env, OPENCODE_EXPERIMENTAL_WORKSPACES: 'true', DAYTONA_SNAPSHOT: snapshot },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (!(await waitForServer(port))) throw new Error('opencode server did not start')
    await fn(port)
  } finally {
    // Wait for the child to actually exit: both tests run servers against the
    // same projectDir, so a still-terminating server from one case can bleed
    // into the next. SIGKILL is the bounded fallback if SIGTERM is ignored.
    const p = proc
    if (p && p.exitCode === null && p.signalCode === null) {
      const exited = new Promise<void>((resolve) => p.once('close', () => resolve()))
      p.kill('SIGTERM')
      const killTimer = setTimeout(() => p.kill('SIGKILL'), 5000)
      // 'close' also waits for stdio to drain, which a descendant inheriting the
      // pipes can block past SIGKILL - cap the wait so teardown can never hang.
      await Promise.race([exited, sleep(10_000)])
      clearTimeout(killTimer)
    }
  }
}

async function createWorkspace(port: number, name: string): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/experimental/workspace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'daytona', name, branch: TEST_BRANCH }),
  })
}

describe.skipIf(!HAS_DAYTONA_KEY)('DAYTONA_SNAPSHOT', () => {
  let daytona: Daytona
  let testDir: string
  let projectDir: string
  let logOffset = 0

  beforeAll(async () => {
    daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY })
    testDir = join(tmpdir(), `snapshot-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
    projectDir = await createTestProject(testDir)
    logOffset = (await readLog()).length
  })

  afterAll(async () => {
    // Sweep from the plugin log rather than tracked names alone, so sandboxes
    // whose create hung or threw still get deleted.
    for (const name of sandboxNamesSince(await readLog(), logOffset)) {
      const sandbox = await daytona.get(name).catch(() => undefined)
      if (sandbox) await daytona.delete(sandbox).catch(() => undefined)
    }
    await rm(testDir, { recursive: true, force: true }).catch(() => undefined)
  })

  test('creates the sandbox from the configured snapshot', async () => {
    await withServer(projectDir, TEST_SNAPSHOT, async (port) => {
      const res = await createWorkspace(port, `snapshot-test-${Date.now()}`)
      const body = await res.text()
      expect(res.ok, `create failed: ${body}`).toBe(true)

      // opencode assigns its own workspace name; read it back rather than
      // assuming the one we posted.
      const workspace = JSON.parse(body)
      const sandbox = await daytona.get(`opencode-${workspace.name}`)
      expect(sandbox.snapshot).toBe(TEST_SNAPSHOT)

      const del = await fetch(`http://127.0.0.1:${port}/experimental/workspace/${workspace.id}`, { method: 'DELETE' })
      expect(del.ok).toBe(true)
    })
  })

  test('fails instead of falling back when the snapshot does not exist', async () => {
    const before = (await readLog()).length

    await withServer(projectDir, NONEXISTENT_SNAPSHOT, async (port) => {
      const res = await createWorkspace(port, `snapshot-missing-${Date.now()}`)
      const body = await res.text()
      expect(res.ok, `expected create to fail, got: ${body}`).toBe(false)
      expect(body).toContain(NONEXISTENT_SNAPSHOT)

      // No silent fallback: nothing may exist under any name the plugin started
      // building during this case.
      for (const name of sandboxNamesSince(await readLog(), before)) {
        expect(await daytona.get(name).catch(() => undefined)).toBeUndefined()
      }
    })
  })
})
