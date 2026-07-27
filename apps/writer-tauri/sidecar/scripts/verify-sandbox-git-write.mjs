// Can the model actually WRITE to the vault's git repo from inside the sandbox?
//
//   CLAUDE_CODE_CLI_PATH=/path/to/claude \
//   CLAUDE_CONFIG_DIR=$(mktemp -d) \
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... \
//   node scripts/verify-sandbox-git-write.mjs
//
// WHY THIS EXISTS SEPARATELY FROM verify-git-revert-and-applied.mjs:
// that harness names its helper `asModel`, but it is Node running `git` with
// the env vars set — it never spawns the sidecar and never enters the sandbox.
// So it verified the GIT_DIR injection and was structurally incapable of
// noticing that writes to the repo were denied. It stayed green while the
// undo-ai-change skill was broken in the app: the model located the commit to
// revert, ran `git revert`, and got
//   fatal: Unable to create '…/git-repos/<h>/.git/index.lock': Operation not permitted
// because the vault's repo lives OUTSIDE the vault (appdata, so a file-sync
// can't corrupt it) and the sandbox confines writes to the workspace.
//
// This one drives a REAL sidecar, a REAL model, and a REAL sandbox.
//
// Scenario 0 is the guard that makes the rest mean anything: the sandbox is
// configured `failIfUnavailable: false`, so on a host where it can't initialise
// every write succeeds and a green run would prove nothing. If the model can
// write somewhere it must not, this harness reports INCONCLUSIVE rather than
// PASS.

import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { FrameParser, encode } from '../src/jsonrpc.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(__dirname, '..', 'src', 'index.mjs')
const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!TOKEN) { console.log('No CLAUDE_CODE_OAUTH_TOKEN set.'); process.exit(2) }

// Mirror the app's layout: work tree (the vault) and git dir in separate trees.
const workTree = mkdtempSync(join(tmpdir(), 'sbx-vault-'))
const gitRoot = mkdtempSync(join(tmpdir(), 'sbx-gitrepo-'))
const gitDir = join(gitRoot, '.git')
const notePath = join(workTree, 'Note.md')
const PROBE = join(homedir(), '.octave-sandbox-probe-DELETE-ME')

const git = (...args) =>
  execFileSync('git', [`--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...args], {
    cwd: workTree, encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  })

git('init', '--quiet')
writeFileSync(notePath, 'ORIGINAL\n')
git('add', 'Note.md'); git('commit', '--quiet', '-m', 'base')
writeFileSync(notePath, 'AI EDIT\n')
git('add', 'Note.md'); git('commit', '--quiet', '-m', 'edit(ai): Note')

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

let failed = false
let inconclusive = false
const ok = (l) => console.log(`  ✓ ${l}`)
const bad = (l, e) => { failed = true; console.log(`  ✗ ${l}${e ? ` — ${e}` : ''}`) }

let assistantText = ''
let toolOutput = ''
// `sandboxEnabled` is a parameter, not a constant, because the only way to show
// the sandbox is doing anything is to run the SAME probe with it off and compare.
// The SDK exposes no signal that the sandbox initialised — no field on the init
// message, no message type, no violation callback (measured against a live run),
// and `failIfUnavailable: false` means a host where Seatbelt can't start runs
// unsandboxed and says nothing. A single "the write failed" assertion is
// therefore not evidence; the DELTA between the two runs is.
function runChat(prompt, { sandboxEnabled = true } = {}) {
  return new Promise((resolve) => {
    const runId = globalThis.crypto.randomUUID()
    notifListeners.push((msg) => {
      if (msg.params?.runId && msg.params.runId !== runId) return
      if (msg.method === 'chat/event' && msg.params?.event?.type === 'assistant') {
        for (const b of msg.params.event.message?.content ?? []) if (b.type === 'text') assistantText += b.text
      }
      // Tool results carry the shell's own stderr — where the denial signature
      // lives. The model's narration is not usable for this: measured, it
      // rewrites the commands it is given.
      if (msg.method === 'chat/event' && msg.params?.event?.type === 'user') {
        for (const b of msg.params.event.message?.content ?? []) {
          const t = typeof b?.content === 'string' ? b.content
            : Array.isArray(b?.content) ? b.content.map((c) => c?.text ?? '').join(' ') : ''
          if (t) toolOutput += t
        }
      }
      if (msg.method === 'chat/done') resolve({ kind: 'ok' })
      else if (msg.method === 'chat/error') resolve({ kind: 'error', code: msg.params.code })
    })
    request('chat', {
      runId, threadId: runId, model: 'claude-sonnet-5', prompt,
      systemPrompt: 'You are a shell operator. Run exactly the command asked, then report the exact stdout/stderr you saw. Do not improvise alternatives.',
      vaultPath: workTree, gitDir, gitWorkTree: workTree,
      relayTools: [], builtinTools: ['Bash'], allowDelegation: false,
      sandboxEnabled,
    }).catch((err) => resolve({ kind: 'error', code: err?.code }))
  })
}

try {
  const init = await request('initialize', {})
  init?.mode === 'chat' ? ok(`initialize (node ${init.node})`) : bad('initialize', JSON.stringify(init))
  const st = await request('setToken', { token: TOKEN })
  st === null ? ok('setToken') : bad('setToken', JSON.stringify(st))

  // ── 0. Is the sandbox actually enforcing? ────────────────────────────────
  //
  // Run one probe TWICE and compare. Absence of the file after the sandboxed
  // run means nothing on its own: the model may have declined, rewritten the
  // command, lost its Bash tool, or the turn may have errored. All of those
  // look exactly like "the sandbox blocked it". The unsandboxed run is the
  // positive control that separates them — if the probe cannot write the file
  // even with nothing in its way, this run proves nothing and says so.
  const probeCmd = `Run this exact command: touch ${PROBE}`
  console.log('\n  --- 0. sandbox is enforcing (differential guard) ---')

  rmSync(PROBE, { force: true })
  assistantText = ''; toolOutput = ''
  await runChat(probeCmd, { sandboxEnabled: false })
  const wroteUnsandboxed = existsSync(PROBE)
  rmSync(PROBE, { force: true })

  assistantText = ''; toolOutput = ''
  await runChat(probeCmd, { sandboxEnabled: true })
  const wroteSandboxed = existsSync(PROBE)
  rmSync(PROBE, { force: true })

  if (!wroteUnsandboxed) {
    inconclusive = true
    console.log('  ! the probe could not write the file even UNSANDBOXED')
    console.log('  ! so its absence under the sandbox is not evidence of anything')
  } else if (wroteSandboxed) {
    inconclusive = true
    console.log(`  ! the model wrote OUTSIDE the vault and repo (${PROBE})`)
    console.log('  ! the sandbox is not enforcing here, so the rest proves nothing')
  } else {
    ok('the same write succeeds unsandboxed and is refused sandboxed')
    // Corroboration only. The denial reaches the shell as EPERM, which zsh
    // renders "operation not permitted" and BSD tools render "Operation not
    // permitted" — shell- and platform-specific, so a miss here is reported
    // without failing the run. The delta above is the actual assertion.
    ;/operation not permitted/i.test(toolOutput)
      ? ok('the refusal carried a permission-denied signature (EPERM)')
      : console.log('  … no EPERM string in the tool output (informational)')
  }

  // ── 1. The fix: git can write to the external repo ───────────────────────
  console.log('\n  --- 1. git revert reaches the external repo ---')
  assistantText = ''
  const r = await runChat(
    'Run this exact command in the current directory: git revert --no-commit HEAD',
  )
  if (r.kind !== 'ok') bad('chat run did not complete', JSON.stringify(r))
  const body = readFileSync(notePath, 'utf-8')
  body.includes('ORIGINAL')
    ? ok('the revert landed — the work tree is back to the pre-edit content')
    : bad('the revert did not land', `Note.md is ${JSON.stringify(body)}`)
  !/index\.lock|Operation not permitted/i.test(assistantText)
    ? ok('no lock-file permission error reported')
    : bad('model reported the sandbox permission error', assistantText.slice(0, 300))

  // ── 2. Naming allowWrite did not REVOKE the workspace ────────────────────
  // The SDK types don't say whether an explicit allowWrite adds to the default
  // writable set or replaces it. If it replaces and we had listed only the git
  // dir, every edit in the vault would have broken instead.
  console.log('\n  --- 2. the vault is still writable ---')
  assistantText = ''
  await runChat('Run this exact command in the current directory: touch sandbox-vault-write.txt')
  existsSync(join(workTree, 'sandbox-vault-write.txt'))
    ? ok('a write inside the vault still succeeds')
    : bad('the vault became unwritable — allowWrite REPLACED the default set')

  await request('shutdown', {}).catch(() => {})
} catch (err) {
  bad('harness threw', err?.message ?? String(err))
} finally {
  setTimeout(() => {
    child.kill('SIGTERM')
    if (inconclusive) console.log('\nRESULT: INCONCLUSIVE (see scenario 0 — nothing below is evidence)')
    else console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
    process.exit(inconclusive ? 2 : failed ? 1 : 0)
  }, 300)
}
