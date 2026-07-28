// Headless behavioural check for compound-loop change B: the profile's bounded
// SUMMARY (## About …) stays always-on, while the growing `## Background` zone
// is carved out and replaced by a one-line pointer telling the model to Read
// the profile file on demand. This can't be unit-tested (it's model behaviour),
// so verify: (1) when a task needs a specific Background fact, the model
// actually Reads the profile file; (2) when it needs no personal facts, it does
// NOT read it (the lean path holds).
//
// Mirrors the app: persona + CLAUDE.md + a SELF PROFILE block containing only
// the About summary + the on-demand pointer (exactly what composeSystemBlocks
// now emits). The full profile (About + Background) sits on disk; the fact the
// task needs lives ONLY in Background.
//
//   CASE=needs (default) — bio needs "where I worked before" (Background only)
//                          → EXPECT a Read of the profile file.
//   CASE=nonpersonal     — summarize arbitrary text → EXPECT no profile Read.
//
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... node scripts/verify-profile-ondemand.mjs

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
const CASE = process.env.CASE === 'nonpersonal' ? 'nonpersonal' : 'needs'

if (!TOKEN) {
  console.log('No CLAUDE_CODE_OAUTH_TOKEN set — cannot run the live model check.')
  process.exit(2)
}

// ── Scratch vault: full profile on disk. The "prior employers" fact lives
//    ONLY in ## Background, so a bio that mentions it forces a Read. ─────────
const vault = mkdtempSync(join(tmpdir(), 'profile-ondemand-vault-'))
mkdirSync(join(vault, 'wiki'), { recursive: true })
const profileRel = 'wiki/Profile.md'
const profilePath = join(vault, profileRel)
const ABOUT = 'A product designer based in Seoul.'
writeFileSync(
  profilePath,
  `## About\n\n${ABOUT}\n\n## Background\n\n` +
    '- Worked at Acme Corp (2015–2018) as a UX designer.\n' +
    '- Founded Discquiet, a community for indie makers, in 2019.\n\n' +
    '## Notes\n\n(private)\n',
)

const persona = readFileSync(join(APP_SRC, 'agents', 'default.md'), 'utf8')
const claudeMd = readFileSync(join(APP_SRC, 'CLAUDE.md'), 'utf8')

// The SELF PROFILE block exactly as composeSystemBlocks now builds it: summary
// (About only) + the on-demand pointer with the absolute profile path.
//
// A COPY, and unlike the currentNoteBlock family it is not pinned by
// harnessProseParity.test.ts — production assembles this inline inside
// composeSystemBlocks (systemPrompt.ts ~204-221) rather than in a callable
// function, so there is nothing to invoke and diff against. If you change the
// pointer wording there, change it here too; nothing will tell you. Extracting
// it into a named function in production would make it pinnable.
const selfProfileBlock =
  `--- SELF PROFILE ---\n## About\n\n${ABOUT}\n\n` +
  `Fuller background facts about the user (history, ongoing projects, ` +
  `relationships, past events) live in the \`## Background\` section of their ` +
  `profile page at \`${profilePath}\`. That section is kept OUT of this prompt ` +
  `to stay lean. When a task needs a specific personal fact the summary above ` +
  `doesn't cover, Read that file first — don't guess or claim you don't know ` +
  `without checking.`

const systemPrompt = [
  persona,
  '--- CLAUDE.md ---',
  claudeMd,
  `--- WORKSPACE ---\nThe vault root is \`${vault}\`.`,
  selfProfileBlock,
].join('\n\n')

// The non-personal task summarises a FILE, not inline text, on purpose. Its
// verdict is "the profile was not Read", which is equally satisfied by a model
// that read nothing at all — including one whose Read tool was never wired up,
// so the check would pass BECAUSE of that bug. Forcing one legitimate Read gives
// the case a positive control: the tool demonstrably works, so leaving the
// profile alone is restraint rather than inaction.
const DECOY_REL = 'wiki/library-notes.md'
writeFileSync(
  join(vault, DECOY_REL),
  'The library ships a parser, a formatter, and a CLI; all three share a config module.\n',
)

const prompt =
  CASE === 'nonpersonal'
    ? `Summarize ${DECOY_REL} in one sentence.`
    : 'Write a one-sentence professional bio for me. Include where I worked before my current thing.'

// ── JSON-RPC plumbing ─────────────────────────────────────────────────────
const child = spawn('node', [SIDECAR, '--mode=chat'], { stdio: ['pipe', 'pipe', 'inherit'] })
const parser = new FrameParser()
let nextId = 1
const pending = new Map()
const notifListeners = []

child.stdout.on('data', (chunk) => {
  parser.push(chunk)
  for (let msg = parser.shift(); msg; msg = parser.shift()) {
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(msg.error) : resolve(msg.result)
    } else if (msg.method) {
      for (const l of notifListeners) l(msg)
    }
  }
})

function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }))
  })
}

let failed = false
const ok = (l) => console.log(`  ✓ ${l}`)
const bad = (l, e) => {
  failed = true
  console.log(`  ✗ ${l}${e ? ` — ${e}` : ''}`)
}

// Capture Read tool calls + assistant text.
const reads = []
let assistantText = ''
notifListeners.push((msg) => {
  if (msg.method !== 'chat/event' || msg.params?.event?.type !== 'assistant') return
  for (const b of msg.params.event.message?.content ?? []) {
    if (b.type === 'text' && typeof b.text === 'string') assistantText += b.text
    if (b.type === 'tool_use' && b.name === 'Read') reads.push(b.input?.file_path ?? '(no path)')
  }
})

function runChat(runId) {
  return new Promise((resolve) => {
    notifListeners.push((msg) => {
      if (msg.params?.runId && msg.params.runId !== runId) return
      if (msg.method === 'chat/done') resolve({ kind: 'ok' })
      else if (msg.method === 'chat/error') resolve({ kind: 'error', code: msg.params.code })
    })
    request('chat', {
      runId,
      model: 'claude-sonnet-5',
      systemPrompt,
      prompt,
      vaultPath: vault,
      relayTools: ['propose_edit', 'propose_write', 'propose_skill', 'move_note'],
      builtinTools: ['Read', 'Glob', 'Grep'],
      allowDelegation: false,
      sandboxEnabled: false,
    }).catch((err) => resolve({ kind: 'error', code: err?.code, message: err?.message }))
  })
}

const readProfile = () => reads.some((p) => p.includes('Profile.md'))

try {
  const init = await request('initialize', {})
  init?.mode === 'chat' ? ok(`initialize (node ${init.node})`) : bad('initialize', JSON.stringify(init))
  const st = await request('setToken', { token: TOKEN })
  st === null ? ok('setToken') : bad('setToken', JSON.stringify(st))

  console.log(`  … running chat turn (case=${CASE})`)
  // The runId doubles as the SDK session id, and the CLI rejects anything that
  // isn't a UUID — "Error: Invalid session ID. Must be a valid UUID." A readable
  // literal here kills the turn before the model runs, surfacing only as an opaque
  // INTERNAL. verify-stale-retry hit this and fixed itself; the note never spread.
  const r = await runChat(globalThis.crypto.randomUUID())
  if (r.kind !== 'ok') bad('chat run did not complete', JSON.stringify(r))

  console.log(`\n  Read calls: ${JSON.stringify(reads)}`)
  console.log('  --- assistant reply ---\n  ' + assistantText.trim().replace(/\n/g, '\n  ') + '\n')

  if (CASE === 'needs') {
    readProfile()
      ? ok('needs a Background fact → model Read the profile file on demand')
      : bad('model did NOT Read the profile despite needing a Background fact')
    // Bonus: did the fact actually make it into the reply?
    if (/acme|discquiet/i.test(assistantText)) ok('reply used a Background-only fact')
    else bad('reply did not include the Background fact')
  } else {
    // POSITIVE CONTROL first: prove Read works at all in this run. Without it,
    // "no profile Read" is indistinguishable from "no Read tool", and the check
    // would score a broken toolset as a pass.
    const readDecoy = reads.some((p) => p.includes('library-notes.md'))
    readDecoy
      ? ok('the Read tool works in this run (decoy file was read)')
      : bad('the decoy file was NOT read — Read is unavailable, so the verdict below is meaningless')
    readProfile()
      ? bad('non-personal task wrongly Read the profile (spurious load)')
      : ok('non-personal task → no profile Read (lean path holds)')
  }

  await request('shutdown', {}).catch(() => {})
} catch (err) {
  bad('harness threw', err?.message ?? String(err))
} finally {
  setTimeout(() => {
    child.kill('SIGTERM')
    console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
    process.exit(failed ? 1 : 0)
  }, 300)
}
