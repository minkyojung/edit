// Physical verification for the two fixes shipped together:
//
//   ① "let the model use real git to undo its edits"
//      - security.mjs now blocks only the `.enc` secret files, NOT the whole
//        app-data folder, so the vault's external git repo (`git-repos/`) is
//        readable.
//      - the sidecar injects GIT_DIR / GIT_WORK_TREE so the model's plain
//        `git log` / `git revert` (undo-ai-change skill) reach that external
//        repo even though the vault itself has no `.git`.
//
//   ② "tell the model its auto-accepted edit was applied, not queued"
//      - the propose_* tool result flips from "queued for user review" to
//        "applied immediately" when the host reports `applied: true`, so the
//        model stops advising the user to reject a review card that never
//        existed.
//
// This is NOT a mock of the mechanism — Part B drives a REAL git repo laid out
// exactly like the app (external git-dir + separate work-tree) using ONLY the
// env vars the sidecar sets, and Part C drives the REAL relay tool handlers.
//
// WHAT IT STILL CANNOT SEE — read this before trusting a green run.
// Part B's helper is named `asModel`, but it is Node running `git` with the env
// vars set. No sidecar, no model, NO SANDBOX. So it verifies the GIT_DIR
// injection and is structurally blind to whether the sandbox permits the write.
// It stayed green while `git revert` was failing in the real app with
//   fatal: Unable to create '…/git-repos/<h>/.git/index.lock': Operation not permitted
// — the repo lives outside the vault and the sandbox confined writes to the
// workspace. verify-sandbox-git-write.mjs covers that, through a real sandbox.
//
// Run:  node scripts/verify-git-revert-and-applied.mjs   (from sidecar/)

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { secretDenyRules, sandboxLockdown } from '../src/policy/security.mjs'
import { buildProposeWriteTool, buildProposeEditTool } from '../src/tools/relay.mjs'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`)
  }
}
function section(t) {
  console.log(`\n${t}`)
}

// ── ① Part A: the security boundary actually opened git-repos ────────────────
section('① Part A — security deny rules: .enc blocked, git-repos open')
{
  const OCTAVE = 'Library/Application Support/com.minkyojung.octave'
  const deny = secretDenyRules()
  const sandbox = sandboxLockdown().filesystem.denyRead

  for (const store of ['claude-oauth', 'google-oauth', 'github-oauth']) {
    check(
      `Read denies ${store}.enc`,
      deny.includes(`Read(~/${OCTAVE}/${store}.enc)`),
    )
    check(
      `sandbox denyRead includes ${store}.enc`,
      sandbox.some((p) => p.endsWith(`/${OCTAVE}/${store}.enc`)),
    )
  }
  // The whole-folder block must be GONE — that was what jailed git.
  check(
    'no deny rule blocks the whole octave folder',
    !deny.includes(`Read(~/${OCTAVE})`) && !deny.includes(`Read(~/${OCTAVE}/**)`),
  )
  check(
    'no deny rule mentions git-repos',
    !deny.some((r) => r.includes('git-repos')),
  )
  check(
    'sandbox denyRead does not block git-repos or the bare folder',
    !sandbox.some((p) => p.includes('git-repos')) &&
      !sandbox.some((p) => p.endsWith(`/${OCTAVE}`)),
  )
}

// ── ① Part B: model's real git commands work via GIT_DIR / GIT_WORK_TREE ─────
section('① Part B — real git undo through env only (external git-dir + worktree)')
{
  const workTree = mkdtempSync(join(tmpdir(), 'octave-vault-'))
  const gitRoot = mkdtempSync(join(tmpdir(), 'octave-gitrepos-'))
  const gitDir = join(gitRoot, '.git') // mirrors appdata::vault_git_dir(...).join(".git")

  // Host-style setup: every command carries --git-dir + --work-tree explicitly.
  const host = (...args) =>
    execFileSync('git', [`--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...args], {
      encoding: 'utf-8',
    })
  try {
    host('init', '-b', 'main')
    host('config', 'user.email', 'test@example.com')
    host('config', 'user.name', 'Test')
    // Persist the worktree so env-only commands (no --work-tree flag) resolve it,
    // exactly like the real repos the app creates.
    host('config', 'core.worktree', workTree)

    const note = join(workTree, 'Note.md')
    writeFileSync(note, 'original line\n')
    host('add', 'Note.md')
    host('commit', '-m', 'base')

    writeFileSync(note, 'AI EDIT\n')
    host('add', 'Note.md')
    host('commit', '-m', 'edit(ai): Note')

    // ── Now BE THE MODEL: cwd = vault, ONLY env vars set, NO --git-dir flag. ──
    const env = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: workTree }
    const asModel = (args, opts = {}) =>
      execFileSync('git', args, { cwd: workTree, encoding: 'utf-8', env, ...opts })

    // Baseline: WITHOUT the env, the vault has no .git → git must fail. This is
    // the exact failure the AI hit ("not a git repository"); proves the env is
    // load-bearing, not incidental.
    let failedWithoutEnv = false
    try {
      execFileSync('git', ['status'], {
        cwd: workTree,
        encoding: 'utf-8',
        env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
        stdio: ['ignore', 'ignore', 'ignore'], // expected to fail — hush git's stderr
      })
    } catch {
      failedWithoutEnv = true
    }
    check('without GIT_DIR env, git in the vault fails (no .git there)', failedWithoutEnv)

    // Skill step 1 — find the (ai) checkpoint (BRE: parens are literal).
    const log = asModel(['log', '--grep=(ai):', '-n', '5', '--format=%h %s'])
    check('model `git log --grep=(ai):` finds the ai checkpoint', log.includes('edit(ai): Note'))

    // Skill step 3 — clean revert of that checkpoint restores the file.
    asModel(['revert', '--no-commit', 'HEAD'])
    check(
      'model `git revert --no-commit HEAD` restores the pre-edit content',
      readFileSync(note, 'utf-8') === 'original line\n',
    )
    asModel(['commit', '-m', 'revert(ai): undo the AI edit'])
    const log2 = asModel(['log', '-n', '1', '--format=%s'])
    check('the revert lands as its own commit', log2.trim() === 'revert(ai): undo the AI edit')
  } finally {
    rmSync(workTree, { recursive: true, force: true })
    rmSync(gitRoot, { recursive: true, force: true })
  }
}

// ── ② Part C: applied signal flips the tool result the model reads ───────────
section('② Part C — auto-accept "applied" flips the tool result text')
{
  const noop = () => {}
  const getRunId = () => 'run-verify'
  // registerAck returns { promise, cleanup }; the handler awaits `promise` (the
  // host's verdict). We resolve it immediately with the ack the host would send.
  const ackWith = (value) => () => ({ promise: Promise.resolve(value), cleanup: noop })

  // propose_write round-trips its own ack and branches on it directly.
  const wApplied = buildProposeWriteTool(getRunId, noop, ackWith({ ok: true, applied: true }))
  const wQueued = buildProposeWriteTool(getRunId, noop, ackWith({ ok: true, applied: false }))
  const wFailed = buildProposeWriteTool(getRunId, noop, ackWith({ ok: false, reason: 'stale' }))

  const input = { file_path: 'Note.md', content: 'hello' }
  const tApplied = (await wApplied.handler(input)).content[0].text
  const tQueued = (await wQueued.handler(input)).content[0].text
  const tFailed = (await wFailed.handler(input)).content[0].text

  check('propose_write applied=true → "Applied immediately"', tApplied.includes('Applied immediately'))
  check('propose_write applied=true → tells model NOT to reject', /never tell the user to reject/i.test(tApplied))
  check('propose_write applied=false → stays "queued for user review"', tQueued.includes('queued for user review'))
  check('propose_write ok=false → "was NOT applied"', tFailed.includes('was NOT applied'))

  // propose_edit round-trips too now. It used to return an optimistic "queued"
  // that a PostToolUse hook rewrote afterwards — delivery measured at ~2/3, so a
  // refusal frequently never reached the model, which then re-proposed the same
  // edit and produced two review cards for one logical edit. The hook is gone
  // and the handler returns the verdict directly; assert all three branches.
  const edit = { file_path: 'Note.md', old_string: 'a', new_string: 'b' }
  const editText = async (ack) =>
    (await buildProposeEditTool(getRunId, noop, ack).handler(edit)).content[0].text

  check(
    'propose_edit applied=true → "Applied immediately"',
    (await editText(ackWith({ ok: true, applied: true }))).includes('Applied immediately'),
  )
  check(
    'propose_edit applied=false → "queued for user review"',
    (await editText(ackWith({ ok: true, applied: false }))).includes('queued for user review'),
  )
  check(
    'propose_edit ok=false → "NOT queued" carrying the reason',
    /NOT queued[\s\S]*stale/.test(await editText(ackWith({ ok: false, reason: 'stale' }))),
  )
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'ALL PASS ✓' : `${failures} FAILURE(S) ✗`}`)
process.exit(failures === 0 ? 0 : 1)
