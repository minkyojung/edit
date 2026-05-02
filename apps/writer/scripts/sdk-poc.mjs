// Phase 0 PoC: verify Claude Agent SDK + OAuth token works without 429.
//
// Usage:
//   1. In Tauri devtools console:
//        await window.__TAURI_INTERNALS__.invoke('get_claude_token')
//   2. Copy the sk-ant-oat... value
//   3. export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...
//   4. cd apps/writer && node scripts/sdk-poc.mjs
//
// Expected: streaming events log to stdout, no 429.

import { query } from '@anthropic-ai/claude-agent-sdk'

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!token) {
  console.error('ERROR: CLAUDE_CODE_OAUTH_TOKEN not set')
  console.error('Get it from Tauri devtools:')
  console.error("  await window.__TAURI_INTERNALS__.invoke('get_claude_token')")
  process.exit(1)
}

if (!token.startsWith('sk-ant-oat')) {
  console.error('ERROR: token does not look like an OAuth token (expected sk-ant-oat...)')
  process.exit(1)
}

// Agent SDK reads exactly this env var. Strip competing creds.
process.env.CLAUDE_CODE_OAUTH_TOKEN = token
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN

console.error('[poc] starting query...')

const start = Date.now()
let eventCount = 0

try {
  const result = query({
    prompt: 'Reply with exactly one word: hello',
    options: {
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypassPermissions',
    },
  })

  for await (const ev of result) {
    eventCount += 1
    console.log(JSON.stringify(ev))
  }

  const elapsed = Date.now() - start
  console.error(`[poc] OK — ${eventCount} events in ${elapsed}ms`)
} catch (err) {
  const elapsed = Date.now() - start
  console.error(`[poc] FAILED after ${elapsed}ms`)
  console.error(err)
  process.exit(2)
}
