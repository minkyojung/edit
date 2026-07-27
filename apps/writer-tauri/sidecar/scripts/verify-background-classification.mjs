// Which tasks count as OUTSTANDING background work — the signal that keeps a
// thread (and its CLI subprocess) alive against the idle reaper and LRU
// eviction.
//
// Pins the fix for a leak measured on SDK 0.3.187 / CLI 2.1.187 (2026-07-27):
// an ordinary BLOCKING subagent emits `task_started` but never a completion
// event, so tracking it left a permanent phantom entry and the thread was
// reported busy forever — neither reapable nor evictable. The SDK offers no way
// to tell the two kinds apart (no flag on `task_started`; no `is_backgrounded`
// for a `background: true` agent; the Stop hook's `background_tasks` snapshot
// reports a long-finished blocking subagent as `status: "running"`), so the host
// classifies by the agent file's own frontmatter.
//
// Both directions matter, and they fail in opposite ways:
//   - blocking subagent tracked   → threads never close, subprocesses pile up
//   - background subagent dropped → a thread gets reaped mid-flight, work lost
//
// If a future SDK starts reporting blocking subagents as completed, the first
// two checks keep passing (the filter just becomes redundant) — see
// #isBackgroundTask in server.mjs, which prefers an explicit SDK flag when one
// ever appears.
//
// Usage:
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... node scripts/verify-background-classification.mjs

// Both directions after the fix, in ONE vault holding both kinds of agent:
//   counter     (no background:)   → must NOT be tracked  (was the leak)
//   slowcounter (background: true) → must     be tracked  (must stay protected)
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { randomUUID } from 'node:crypto'
import { Server } from '../src/server.mjs'
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
const vault = mkdtempSync(join(tmpdir(), 'probefix-'))
mkdirSync(join(vault, '_system/agent/.claude-plugin'), { recursive: true })
mkdirSync(join(vault, '_system/agent/agents'), { recursive: true })
writeFileSync(join(vault, '_system/agent/.claude-plugin/plugin.json'), JSON.stringify({ name:'writer-agent-skills', version:'0.1.0', description:'p' }))
writeFileSync(join(vault, '_system/agent/agents/counter.md'),
  `---\nname: counter\ndescription: count to three\ntools: ["Bash"]\n---\nRun one Bash command: \`for i in 1 2 3; do echo "c $i"; sleep 1; done\` then say "done".\n`)
writeFileSync(join(vault, '_system/agent/agents/slowcounter.md'),
  `---\nname: slowcounter\ndescription: slow background count\ntools: ["Bash"]\nbackground: true\n---\nRun one Bash command: \`for i in $(seq 1 12); do echo "c $i"; sleep 1; done\` then say "done".\n`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const ev = { done: [], task: [] }
const server = new Server({ mode:'chat', emit: (m) => {
  if (m.method === 'chat/done') ev.done.push(m.params)
  else if (m.method === 'chat/task') ev.task.push(m.params) } })
const send = (m,p,i) => server.handle({ jsonrpc:'2.0', id:i, method:m, params:p })
const waitFor = async (p,ms) => { const s=Date.now(); while(Date.now()-s<ms){ if(p())return true; await sleep(200)} return false }
let fail = false
const check = (n, ok, d='') => { if(!ok) fail = true; console.log(`  ${ok?'✓':'✗'} ${n}${d?` — ${d}`:''}`) }
send('initialize',{},1); send('setToken',{token},2)

// A — ordinary blocking subagent
const t1 = randomUUID(), a1 = randomUUID()
send('chat',{runId:a1,threadId:t1,persistentQuery:true,vaultPath:vault,builtinTools:['Bash','Task'],
  prompt:'Use the Task tool to delegate to the counter subagent. Wait for it and report what it said.'},3)
await waitFor(()=>ev.done.some(d=>d.runId===a1),120000)
const r1 = server.activeThreads.get(t1)
check('blocking subagent still shown in the UI', ev.task.some(t=>t.kind==='started'))
check('blocking subagent NOT counted as background work', r1.backgroundTaskIds.size === 0, `size=${r1.backgroundTaskIds.size}`)
check('thread is reapable again', !(r1.turnActive || r1.turnQueue.length > 0 || r1.backgroundTaskIds.size > 0))
send('chat/close-thread',{threadId:t1}); await sleep(300)

// B — fire-and-forget subagent
ev.task.length = 0
const t2 = randomUUID(), a2 = randomUUID()
send('chat',{runId:a2,threadId:t2,persistentQuery:true,vaultPath:vault,builtinTools:['Bash','Task'],
  prompt:'Delegate to the slowcounter subagent via Task, then one sentence that it runs in the background. Do not wait.'},4)
await waitFor(()=>ev.task.some(t=>t.kind==='started'&&t.subagentType),90000)
const r2 = server.activeThreads.get(t2)
check('background subagent IS counted (still protected)', r2.backgroundTaskIds.size > 0, `size=${r2.backgroundTaskIds.size}`)
// Wait for the SET to drain, not for the first notification: a subagent's
// inner task notifies a few seconds before the subagent itself does.
await waitFor(()=>r2.backgroundTaskIds.size===0,90000)
check('cleared once it settles', r2.backgroundTaskIds.size === 0, `size=${r2.backgroundTaskIds.size}`)
send('chat/close-thread',{threadId:t2}); await sleep(400)
rmSync(vault,{recursive:true,force:true})
console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS'); process.exit(fail?1:0)
