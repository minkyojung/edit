// Headless end-to-end check for the `query_notes` tool + its data-carrying
// request/response bridge. Drives a live sidecar; this harness plays the HOST:
// when the sidecar emits `chat/query-notes`, it replies with `chat/query-result`
// carrying canned references (as the real frontend would after filtering
// knownDocs). Verifies the model (a) calls query_notes with the right filter
// and (b) uses the returned references in its answer.
//
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... node scripts/verify-query-notes.mjs

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { FrameParser, encode } from '../src/jsonrpc.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(__dirname, '..', 'src', 'index.mjs')
const APP_SRC = join(__dirname, '..', '..', 'src', 'agent', 'defaults')
const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!TOKEN) { console.log('No CLAUDE_CODE_OAUTH_TOKEN set.'); process.exit(2) }

// Scratch vault with two notes the canned refs point at, so a follow-up Read works.
const vault = mkdtempSync(join(tmpdir(), 'query-vault-'))
mkdirSync(join(vault, 'wiki'), { recursive: true })
writeFileSync(join(vault, 'wiki', 'Alpha.md'), '---\nstatus: in-progress\n---\n\nAlpha: migrating the billing service. Halfway through.\n')
writeFileSync(join(vault, 'wiki', 'Beta.md'), '---\nstatus: in-progress\n---\n\nBeta: drafting the onboarding email sequence.\n')

const persona = readFileSync(join(APP_SRC, 'agents', 'default.md'), 'utf8')
const claudeMd = readFileSync(join(APP_SRC, 'CLAUDE.md'), 'utf8')
const systemPrompt = [persona, '--- CLAUDE.md ---', claudeMd, '--- WORKSPACE ---', `Vault root (absolute): ${vault}`].join('\n\n')

const child = spawn('node', [SIDECAR, '--mode=chat'], { stdio: ['pipe', 'pipe', 'inherit'] })
const parser = new FrameParser()
let nextId = 1
const pending = new Map()
const notifListeners = []
child.stdout.on('data', (chunk) => {
  parser.push(chunk)
  for (let msg = parser.shift(); msg; msg = parser.shift()) {
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id)
      msg.error ? reject(msg.error) : resolve(msg.result)
    } else if (msg.method) { for (const l of notifListeners) l(msg) }
  }
})
function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(encode({ jsonrpc: '2.0', id, method, params })) })
}
function notify(method, params) { child.stdin.write(encode({ jsonrpc: '2.0', method, params })) }

let failed = false
const ok = (l) => console.log(`  ✓ ${l}`)
const bad = (l, e) => { failed = true; console.log(`  ✗ ${l}${e ? ` — ${e}` : ''}`) }

let queryWhere = null
let assistantText = ''
notifListeners.push((msg) => {
  if (msg.method === 'chat/event' && msg.params?.event?.type === 'assistant') {
    for (const b of msg.params.event.message?.content ?? []) if (b.type === 'text') assistantText += b.text
  }
  // HOST role: answer the query with canned references (as the frontend would).
  if (msg.method === 'chat/query-notes') {
    queryWhere = msg.params?.where ?? {}
    console.log(`  … sidecar asked query_notes where=${JSON.stringify(queryWhere)}`)
    notify('chat/query-result', {
      queryId: msg.params.queryId,
      results: [
        { path: 'wiki/Alpha.md', title: 'Alpha', status: 'in-progress', tags: [] },
        { path: 'wiki/Beta.md', title: 'Beta', status: 'in-progress', tags: [] },
      ],
      nextCursor: null,
    })
  }
})

function runChat(runId, prompt) {
  return new Promise((resolve) => {
    notifListeners.push((msg) => {
      if (msg.params?.runId && msg.params.runId !== runId) return
      if (msg.method === 'chat/done') resolve({ kind: 'ok' })
      else if (msg.method === 'chat/error') resolve({ kind: 'error', code: msg.params.code })
    })
    request('chat', {
      runId, model: 'claude-sonnet-5', systemPrompt, prompt, vaultPath: vault,
      relayTools: ['query_notes', 'set_note_status', 'set_note_tags'],
      builtinTools: ['Read', 'Glob', 'Grep'], allowDelegation: false, sandboxEnabled: false,
    }).catch((err) => resolve({ kind: 'error', code: err?.code, message: err?.message }))
  })
}

try {
  const init = await request('initialize', {})
  init?.mode === 'chat' ? ok(`initialize (node ${init.node})`) : bad('initialize', JSON.stringify(init))
  const st = await request('setToken', { token: TOKEN })
  st === null ? ok('setToken') : bad('setToken', JSON.stringify(st))

  console.log('  … running chat: "Summarize my in-progress notes."')
  const r = await runChat('query-1', 'Summarize my in-progress notes.')
  if (r.kind !== 'ok') bad('chat run did not complete', JSON.stringify(r))

  console.log('\n  --- assistant reply ---\n  ' + assistantText.trim().replace(/\n/g, '\n  ') + '\n')

  queryWhere ? ok('model called query_notes') : bad('model did NOT call query_notes')
  if (queryWhere) {
    queryWhere.status === 'in-progress'
      ? ok("query filter where.status === 'in-progress'")
      : bad('query filter wrong', JSON.stringify(queryWhere))
  }
  const usedRefs = /alpha|beta|billing|onboarding/i.test(assistantText)
  usedRefs ? ok('reply reflects the returned references (Alpha/Beta)') : bad('reply did not use the returned notes')

  await request('shutdown', {}).catch(() => {})
} catch (err) {
  bad('harness threw', err?.message ?? String(err))
} finally {
  setTimeout(() => { child.kill('SIGTERM'); console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS'); process.exit(failed ? 1 : 0) }, 300)
}
