/*
 * Integration test. Mirrors app/api/copilotkit/route.ts wiring and exercises the
 * live services: an OpenRouter completion + tool call, and a Daytona sandbox
 * lifecycle (create → run command → preview URL → delete).
 *
 * Needs live keys and creates a real sandbox + a small paid model call, so it's
 * a manual/preflight check, not a CI unit test. Run it with:
 *   npm test                     # loads .env / .env.local automatically
 *   node scripts/test.mjs
 */
import { readFileSync } from 'node:fs'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, tool, stepCountIs } from 'ai'
import { z } from 'zod'
import { Daytona } from '@daytona/sdk'

// Load .env / .env.local ourselves rather than relying on `node --env-file`, so
// this runs on any Node >=20 without depending on a version-specific CLI flag.
for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq === -1) continue
      const key = t.slice(0, eq).trim()
      let val = t.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (key && process.env[key] === undefined) process.env[key] = val
    }
  } catch {
    // .env files are optional
  }
}

const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`)
const fail = (m) => console.log(`\x1b[31m✗\x1b[0m ${m}`)

// ── OpenRouter wiring (mirrors route.ts) ────────────────────────────────────
function resolveOpenRouterKey() {
  // OPENROUTER_API_KEY (manual) or OPENROUTER_API_API_KEY (stripe projects add openrouter/api).
  return process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_API_KEY
}
const openrouter = createOpenAI({
  apiKey: resolveOpenRouterKey(),
  baseURL: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
})
const MODEL = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4.5'

// ── Daytona wiring (mirrors route.ts) ───────────────────────────────────────
const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY ?? process.env.DAYTONA_SANDBOX_API_KEY,
  apiUrl:
    process.env.DAYTONA_API_URL ??
    process.env.DAYTONA_SANDBOX_API_URL ??
    'https://app.daytona.io/api',
  organizationId:
    process.env.DAYTONA_ORGANIZATION_ID ?? process.env.DAYTONA_SANDBOX_ORGANIZATION_ID,
})

// Fail fast with a clear message if credentials aren't present.
const missing = []
if (!resolveOpenRouterKey()) missing.push('OPENROUTER_API_KEY')
if (!(process.env.DAYTONA_API_KEY ?? process.env.DAYTONA_SANDBOX_API_KEY))
  missing.push('DAYTONA_API_KEY (or DAYTONA_SANDBOX_API_KEY)')
if (missing.length > 0) {
  fail(`Missing credentials: ${missing.join(', ')}`)
  console.log('  Add them to .env, then: npm test')
  process.exit(1)
}

let failures = 0

// ── Test 1: OpenRouter chat completion via .chat() ──────────────────────────
console.log(`\n[1/3] OpenRouter completion — model: ${MODEL}`)
try {
  const res = await generateText({
    model: openrouter.chat(MODEL),
    prompt: 'Reply with exactly the single word: PONG',
  })
  if (/pong/i.test(res.text)) ok(`completion works → "${res.text.trim()}"`)
  else {
    fail(`unexpected reply: "${res.text.trim()}"`)
    failures++
  }
} catch (e) {
  fail(`OpenRouter completion failed: ${e?.message ?? e}`)
  failures++
}

// ── Test 2: OpenRouter tool-calling (the agent's core mechanic) ─────────────
console.log(`\n[2/3] OpenRouter tool-calling`)
try {
  const res = await generateText({
    model: openrouter.chat(MODEL),
    prompt: 'Call the ping tool with value "hello". After it returns, reply with exactly: DONE',
    tools: {
      ping: tool({
        description: 'Echo the provided value back.',
        inputSchema: z.object({ value: z.string() }),
        execute: async ({ value }) => ({ pong: value }),
      }),
    },
    stopWhen: stepCountIs(5),
  })
  const calls = (res.steps ?? []).flatMap((s) => s.toolCalls ?? [])
  if (calls.length > 0) ok(`tool-calling works → called ${calls.map((c) => c.toolName).join(', ')}`)
  else {
    fail(`model did not call the tool (text: "${res.text.trim()}")`)
    failures++
  }
} catch (e) {
  fail(`OpenRouter tool-calling failed: ${e?.message ?? e}`)
  failures++
}

// ── Test 3: Daytona sandbox → command → preview URL → cleanup ───────────────
console.log(`\n[3/3] Daytona sandbox lifecycle`)
let sandbox
try {
  sandbox = await daytona.create({ public: true, ephemeral: true })
  ok(`createSandbox → ${sandbox.id}`)

  const r = await sandbox.process.executeCommand('echo hello-from-daytona')
  if (r.exitCode === 0 && /hello-from-daytona/.test(r.result)) ok(`runCommand → "${r.result.trim()}"`)
  else {
    fail(`runCommand unexpected (exit ${r.exitCode}): ${r.result}`)
    failures++
  }

  const preview = await sandbox.getPreviewLink(5173)
  if (preview?.url?.startsWith('http')) ok(`getPreviewUrl → ${preview.url}`)
  else {
    fail(`getPreviewLink returned no url`)
    failures++
  }
} catch (e) {
  fail(`Daytona lifecycle failed: ${e?.message ?? e}`)
  failures++
} finally {
  if (sandbox) {
    try {
      await sandbox.delete()
      ok(`cleaned up sandbox ${sandbox.id}`)
    } catch (e) {
      fail(`cleanup failed (delete manually): ${e?.message ?? e}`)
      failures++
    }
  }
}

console.log(`\n${failures === 0 ? '\x1b[32mALL CHECKS PASSED\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`}`)
process.exit(failures === 0 ? 0 : 1)
