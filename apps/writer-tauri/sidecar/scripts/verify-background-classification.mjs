// Which work keeps a chat thread (and its CLI subprocess) alive.
//
// Two directions, and they fail in opposite ways:
//   - a BLOCKING subagent counted as background → the thread is never reaped or
//     evicted, and subprocesses pile up for as long as the app runs
//   - a BACKGROUND subagent NOT counted → the thread is torn down mid-flight and
//     the user silently loses the result
//
// The set is driven solely by `background_tasks_changed` (REPLACE semantics).
// Measured on CLI 2.1.220: a blocking subagent emits no such event at all, a
// `background: true` one emits the task then `[]`, and a `run_in_background`
// Bash behaves like the latter with `task_type: 'local_bash'`.
//
// Assertions call `threadBusy()` from the product rather than restating it —
// see the note at the first use.
//
// Usage:
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... node scripts/verify-background-classification.mjs

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { randomUUID } from 'node:crypto'
import { Server, threadBusy } from '../src/server.mjs'
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
// Every sibling harness guards here; this one didn't. Without it, no token means
// both chats fail, `waitFor` burns its 120s, and the run dies on a TypeError
// reading `.backgroundTaskIds` of undefined — it never prints RESULT: FAIL, so
// anything reading the output rather than the exit code misses the failure.
//   0 = PROVED   1 = DISPROVED   2 = COULD NOT DETERMINE (incl. no token)
if (!token) { console.log('No CLAUDE_CODE_OAUTH_TOKEN set.'); process.exit(2) }
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
// CALL the product predicate. An earlier revision restated it here and dropped
// two of the three signals it had at the time, so this line reported "reapable"
// while the reaper still saw the thread as busy — green on exactly the bug it
// existed to catch.
check('thread is reapable again', !threadBusy(r1), `threadBusy=${threadBusy(r1)}`)
send('chat/close-thread',{threadId:t1}); await sleep(300)

// B — fire-and-forget subagent
ev.task.length = 0
const t2 = randomUUID(), a2 = randomUUID()
send('chat',{runId:a2,threadId:t2,persistentQuery:true,vaultPath:vault,builtinTools:['Bash','Task'],
  prompt:'Delegate to the slowcounter subagent via Task, then one sentence that it runs in the background. Do not wait.'},4)
await waitFor(()=>ev.task.some(t=>t.kind==='started'&&t.subagentType),90000)
const r2 = server.activeThreads.get(t2)
check('background subagent IS counted (still protected)', r2.backgroundTaskIds.size > 0, `size=${r2.backgroundTaskIds.size}`)
check('and the thread is protected from reaping while it runs', threadBusy(r2))
// Wait for the SET to drain, not for the first notification: a subagent's
// inner task notifies a few seconds before the subagent itself does.
await waitFor(()=>r2.backgroundTaskIds.size===0,90000)
check('cleared once it settles', r2.backgroundTaskIds.size === 0, `size=${r2.backgroundTaskIds.size}`)
check('and the thread becomes reapable again', !threadBusy(r2))
send('chat/close-thread',{threadId:t2}); await sleep(400)
rmSync(vault,{recursive:true,force:true})
console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS'); process.exit(fail?1:0)
