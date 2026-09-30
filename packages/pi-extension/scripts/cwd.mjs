/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live test for the sandbox-cwd fix (issue #66).
 * Newer Pi resolves each tool's cwd as `ctx?.cwd || cwd`, where ctx.cwd is the
 * HOST session cwd. Sent to the sandbox, every bash call failed with
 * "fork/exec /usr/bin/zsh: no such file or directory". Drives the registered
 * tools (through registerTools' sandbox wrapper) with a host ctx.cwd and checks
 * they run in the sandbox cwd instead.
 *
 * Requires DAYTONA_API_KEY.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
// See bash-bg.mjs for why the host entry is resolved this way.
const hostEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
const { createJiti } = createRequire(hostEntry)('jiti')
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { '@earendil-works/pi-coding-agent': hostEntry },
})
const { Daytona } = await import('@daytona/sdk')

let pass = 0,
  fail = 0
const failures = []
const check = (cond, msg, detail) => {
  if (cond) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fail++
    failures.push(msg)
    console.log(`  ✗ ${msg}${detail ? ` — ${detail}` : ''}`)
  }
}

const { registerTools } = await jiti.import(path.join(root, 'src/tools.ts'))

const daytona = new Daytona()
let sandbox
try {
  sandbox = await daytona.create({ ephemeral: true, labels: { 'created-by': 'pi-daytona-test' } })
  const home = (await sandbox.getUserHomeDir()) ?? '/home/daytona'
  const cwd = `${home}/proj`
  await sandbox.fs.createFolder(cwd, '755')

  const tools = {}
  const stubPi = {
    registerTool: (tool) => (tools[tool.name] = tool),
    on: () => {},
    getFlag: (name) => (name === 'daytona' ? true : undefined),
  }
  registerTools(stubPi, () => ({ sandbox, cwd }))

  // Mimic Pi's tool ctx: a HOST cwd plus lazy getters that must survive the
  // wrapper's cwd override (Pi's bash tool reads ctx.sessionManager).
  const hostCwd = process.cwd()
  const ctx = {
    get cwd() {
      return hostCwd
    },
    get sessionManager() {
      return { getSessionId: () => 'test-session', getSessionFile: () => undefined }
    },
    get model() {
      return undefined
    },
  }
  const run = (name, params) => tools[name].execute(`t-${name}`, params, undefined, undefined, ctx)
  const text = (r) => r?.content?.map((c) => c.text ?? '').join('') ?? ''

  console.log(`host ctx.cwd=${hostCwd}, sandbox cwd=${cwd}`)
  const pwd = text(await run('bash', { command: 'pwd' })).trim()
  check(pwd === cwd, 'bash runs in the sandbox cwd, not the host cwd', JSON.stringify(pwd))
  check(!/fork\/exec/.test(pwd), 'no "fork/exec <shell>" error (issue #66)', JSON.stringify(pwd))

  await run('write', { path: 'note.txt', content: 'hi from pi\n' })
  const cat = text(await run('bash', { command: 'cat note.txt' })).trim()
  check(cat === 'hi from pi', 'write resolves relative paths against the sandbox cwd', JSON.stringify(cat))

  const read = text(await run('read', { path: 'note.txt' }))
  check(/hi from pi/.test(read), 'read resolves relative paths against the sandbox cwd', JSON.stringify(read))

  await run('edit', { path: 'note.txt', edits: [{ oldText: 'hi', newText: 'bye' }] })
  const edited = text(await run('bash', { command: 'cat note.txt' })).trim()
  check(edited === 'bye from pi', 'edit resolves relative paths against the sandbox cwd', JSON.stringify(edited))

  const ls = text(await run('ls', {}))
  check(/note\.txt/.test(ls), 'ls defaults to the sandbox cwd', JSON.stringify(ls))
} catch (e) {
  check(false, 'aborted early', e?.message)
} finally {
  if (sandbox) await sandbox.delete().catch(() => {})
  console.log('  (sandbox deleted)')
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log('Failures:\n' + failures.map((f) => `  - ${f}`).join('\n'))
  process.exitCode = 1
}
