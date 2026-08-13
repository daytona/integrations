/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Integration test that runs OpenCode with the Daytona plugin
 * and tests workspace creation via the API.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, ChildProcess } from 'node:child_process'
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Daytona } from '@daytona/sdk'

// Default to the binary npm ci installs (opencode-ai ships it as platform
// optionalDependencies), not a global install. This test spawns it by absolute
// path, so unlike plugin.test.ts it gets no help from node_modules/.bin being on
// PATH. Set OPENCODE_BIN to point at a local OpenCode build instead.
const OPENCODE_BIN = process.env.OPENCODE_BIN || resolve(import.meta.dir, '../node_modules/.bin/opencode')
const HAS_DAYTONA_KEY = Boolean(process.env.DAYTONA_API_KEY)

// The real plugin, loaded from source — see createTestProject().
const PLUGIN_PATH = resolve(import.meta.dir, '../.opencode/plugin/index.ts')
const PLUGIN_SPEC = `file://${PLUGIN_PATH}`

// The plugin's own debug log. It records every workspace it starts building,
// which is the only reliable way to know what to clean up when a create call
// hangs rather than returning. Kept in sync with e2e-tui.test.ts.
const PLUGIN_LOG = '/tmp/daytona-plugin.log'
async function readLog(): Promise<string> {
  return await readFile(PLUGIN_LOG, 'utf8').catch(() => '')
}

// Branch the test repo is pinned to, and the branch the workspace is asked for.
// These must agree: the plugin clones with --branch, so a mismatch fails create.
const TEST_BRANCH = 'main'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

async function spawnAsync(cmd: string[], options: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    proc.on('close', (code: number | null) => {
      if (code === 0) resolve(stdout)
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
      // opencode server (spawned with piped stdio) can hang indefinitely even
      // though the server is healthy. Without a timeout that single stuck fetch
      // wedges the whole loop until the test hook times out. AbortSignal.timeout
      // makes the request reject so the loop actually retries.
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

  // Create test files
  await writeFile(join(projectDir, 'README.md'), '# Integration Test Project\n')
  await writeFile(join(projectDir, 'index.ts'), 'export const hello = () => "Hello!";\n')
  await writeFile(join(projectDir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0' }, null, 2))

  // Create src directory
  await mkdir(join(projectDir, 'src'))
  await writeFile(join(projectDir, 'src', 'main.ts'), 'console.log("main");\n')

  // Initialize git
  await spawnAsync(['git', 'init'], { cwd: projectDir })
  await spawnAsync(['git', 'config', 'user.email', 'test@test.com'], { cwd: projectDir })
  await spawnAsync(['git', 'config', 'user.name', 'Test'], { cwd: projectDir })
  await spawnAsync(['git', 'add', '-A'], { cwd: projectDir })
  await spawnAsync(['git', 'commit', '-m', 'init'], { cwd: projectDir })
  // Force the branch name rather than inheriting the host's init.defaultBranch,
  // which varies (master on older git, main on newer). The workspace is created
  // with `branch: TEST_BRANCH`, and the plugin passes that to `git clone --branch`.
  await spawnAsync(['git', 'branch', '-M', TEST_BRANCH], { cwd: projectDir })

  // Load the REAL plugin, the same way plugin.test.ts does: a file:// spec
  // pointing at this package's source.
  //
  // This previously inlined a ~115-line copy of the adapter. The copy drifted
  // from the real plugin and was missing two fixes that matter here: the
  // create() error path (so a failure leaked its sandbox) and the bounded
  // health polls (so it hung instead of failing). A copy of the thing under
  // test proves nothing about the thing under test.
  //
  // No npm install in the temp project either — the plugin's imports resolve
  // from this package's node_modules, because the spec points inside it.
  await writeFile(
    join(projectDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        plugin: [PLUGIN_SPEC],
      },
      null,
      2,
    ),
  )

  return projectDir
}

describe.skipIf(!HAS_DAYTONA_KEY)('integration', () => {
  let testDir: string
  let projectDir: string
  let serverProc: ChildProcess | null = null
  let serverPort: number
  let createdSandboxId: string | null = null
  let daytona: Daytona
  let logOffset = 0

  beforeAll(async () => {
    daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY })
    serverPort = await freePort()
    testDir = join(tmpdir(), `integration-test-${Date.now()}`)

    console.log('\n=== Step 1: Create test project with plugin ===')
    await mkdir(testDir, { recursive: true })
    projectDir = await createTestProject(testDir)
    console.log(`Project created at: ${projectDir}`)

    console.log(`Plugin loaded from: ${PLUGIN_SPEC}`)
    logOffset = (await readLog()).length

    console.log('\n=== Step 2: Start OpenCode server ===')
    console.log(`Running: ${OPENCODE_BIN} serve --port ${serverPort}`)

    serverProc = spawn(OPENCODE_BIN, ['serve', '--port', String(serverPort)], {
      cwd: projectDir,
      env: {
        ...process.env,
        OPENCODE_EXPERIMENTAL_WORKSPACES: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    serverProc.stdout?.on('data', (d: Buffer) => {
      process.stdout.write(d)
    })
    serverProc.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(d)
    })

    console.log('Waiting for server...')
    const serverReady = await waitForServer(serverPort)
    if (!serverReady) {
      throw new Error('Server did not start')
    }
    console.log('Server is ready!')
  })

  afterAll(async () => {
    console.log('\n=== Cleanup ===')

    if (serverProc) {
      console.log('Stopping server...')
      serverProc.kill('SIGTERM')
    }

    // Sweep, rather than relying on createdSandboxId alone. That variable is only
    // assigned once the create request comes back, so anything that stops the
    // request returning — a hang, a client-side timeout, a failed assertion —
    // used to leave a running sandbox behind with nothing recording its name.
    // The plugin logs every workspace it starts building, so parse that instead.
    const doomed = new Set<string>()
    if (createdSandboxId) doomed.add(createdSandboxId)
    for (const m of (await readLog()).slice(logOffset).matchAll(/create: start name=(\S+)/g)) {
      doomed.add(`opencode-${m[1]}`)
    }

    for (const idOrName of doomed) {
      console.log(`Deleting sandbox ${idOrName}...`)
      try {
        const sandbox = await daytona.get(idOrName)
        await daytona.delete(sandbox)
      } catch {
        // Already gone, or never created — either way nothing to clean up.
      }
    }

    console.log('Removing test directory...')
    await rm(testDir, { recursive: true, force: true }).catch(() => undefined)
  })

  test('registers daytona workspace adapter', async () => {
    console.log('\n=== Step 3: Check workspace adapters ===')
    const adaptersRes = await fetch(`http://127.0.0.1:${serverPort}/experimental/workspace/adapter`)
    const adapters = await adaptersRes.json()
    console.log('Adapters:', JSON.stringify(adapters, null, 2))

    expect(Array.isArray(adapters)).toBe(true)
    expect(adapters.some((a: { type: string }) => a.type === 'daytona')).toBe(true)
  })

  test('creates and deletes workspace via API', async () => {
    console.log('\n=== Step 4: Create workspace via API ===')
    const createRes = await fetch(`http://127.0.0.1:${serverPort}/experimental/workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'daytona',
        name: `integration-test-${Date.now()}`,
        branch: TEST_BRANCH,
      }),
    })

    console.log(`Create response status: ${createRes.status}`)
    const createBody = await createRes.text()
    console.log(`Create response body: ${createBody}`)

    expect(createRes.ok).toBe(true)

    const workspace = JSON.parse(createBody)
    console.log('Workspace created:', workspace)

    // Step 5: Verify sandbox
    console.log('\n=== Step 5: Verify sandbox contents ===')
    const sandboxName = `opencode-${workspace.name}`
    await sleep(5000)

    const sandbox = await daytona.get(sandboxName)
    createdSandboxId = sandbox.id

    const files = await sandbox.process.executeCommand('ls -la /home/daytona/workspace/repo')
    console.log('Sandbox files:', files.result)
    expect(files.exitCode).toBe(0)

    // Step 6: Clean up workspace
    console.log('\n=== Step 6: Clean up workspace ===')
    const deleteRes = await fetch(`http://127.0.0.1:${serverPort}/experimental/workspace/${workspace.id}`, {
      method: 'DELETE',
    })
    console.log(`Delete response: ${deleteRes.status}`)
    expect(deleteRes.ok).toBe(true)

    // Mark as cleaned up so afterAll doesn't try again
    createdSandboxId = null
  })
})
