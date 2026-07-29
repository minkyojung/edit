// Token-free verification that the sidecar can be a JSON-RPC *peer*, not just
// a server: mint a request, recognise the host's response, and settle every
// pending request when the connection goes away.
//
// Drives the REAL Server class. No SDK mock is needed — none of this touches
// `query()`. What it does NOT cover: framing, stdio, and index.mjs, which it
// bypasses entirely (same limitation as verify-lifecycle).
//
//   node verify-bidirectional.mjs

const SIDECAR = '..'
const { Server } = await import(`${SIDECAR}/src/server.mjs`)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A Server with every emitted message captured, plus a `send` that plays the
 *  host. Nothing here is framed — `handle` takes message objects. */
function makeServer() {
  const out = []
  const server = new Server({ mode: 'chat', emit: (m) => out.push(m) })
  const send = (msg) => server.handle(msg)
  return { server, send, out }
}

console.log('\n── T1: a host response is not answered with METHOD_NOT_FOUND ──')
{
  const { send, out } = makeServer()
  // A response carries an id and NO method. Classifying on `method` alone sends
  // "Method not found: undefined" straight back at the host, which is both
  // wrong and a frame the host will then log as unaddressable.
  await send({ jsonrpc: '2.0', id: 'host-reply-1', result: { ok: true } })
  await sleep(10)
  const bounced = out.find((m) => m.error?.code === -32601)
  check('no METHOD_NOT_FOUND bounced back', !bounced, bounced ? JSON.stringify(bounced) : '')
  check('nothing emitted at all for an unknown response id', out.length === 0, `emitted ${out.length}`)
}

console.log('\n── T2: the sidecar can ask the host a question ──')
{
  const { server, send, out } = makeServer()
  const answer = server.peer.request('host/ping', { hello: true })

  const asked = out.find((m) => m.method === 'host/ping')
  check('a request frame went out', !!asked)
  check('it carries an id', asked?.id !== undefined, `id=${JSON.stringify(asked?.id)}`)
  check('it is not a notification', asked?.id !== undefined && !!asked?.method)
  check('params are carried', asked?.params?.hello === true)

  // The host answers.
  await send({ jsonrpc: '2.0', id: asked.id, result: { pong: 1 } })
  const value = await answer
  check('the promise resolves with the result', value?.pong === 1, JSON.stringify(value))
}

console.log('\n── T3: an error response rejects the caller ──')
{
  const { server, send, out } = makeServer()
  const answer = server.peer.request('host/nope', {})
  const asked = out.find((m) => m.method === 'host/nope')
  await send({
    jsonrpc: '2.0',
    id: asked.id,
    error: { code: -32601, message: 'method not found: host/nope' },
  })
  let rejected = null
  try {
    await answer
  } catch (e) {
    rejected = e
  }
  check('the promise rejects', !!rejected)
  check('the error carries the code', rejected?.code === -32601, `code=${rejected?.code}`)
  check('the error carries the message', /host\/nope/.test(rejected?.message ?? ''))
}

console.log('\n── T4: two questions in flight do not cross ──')
{
  const { server, send, out } = makeServer()
  const a = server.peer.request('host/a', {})
  const b = server.peer.request('host/b', {})
  const askedA = out.find((m) => m.method === 'host/a')
  const askedB = out.find((m) => m.method === 'host/b')
  check('ids are distinct', askedA.id !== askedB.id, `${askedA.id} vs ${askedB.id}`)
  // Answer out of order, which JSON-RPC permits.
  await send({ jsonrpc: '2.0', id: askedB.id, result: 'B' })
  await send({ jsonrpc: '2.0', id: askedA.id, result: 'A' })
  check('each caller got its own answer', (await a) === 'A' && (await b) === 'B')
}

console.log('\n── T5: a dead connection settles every pending request ──')
{
  const { server } = makeServer()
  const a = server.peer.request('host/x', {})
  const b = server.peer.request('host/y', {})
  // This is the guarantee the transport owes its callers, and the one the
  // three hand-rolled bridges each invented a different timeout to fake.
  server.peer.settleAll(new Error('connection closed'))
  let aErr = null
  let bErr = null
  try { await a } catch (e) { aErr = e }
  try { await b } catch (e) { bErr = e }
  check('both callers were released', !!aErr && !!bErr)
  check('nobody is left waiting', server.peer.pendingCount === 0, `pending=${server.peer.pendingCount}`)
}

console.log('\n── T5b: shutdown() releases them too ──')
{
  // Wiring check, not a unit check: `settleAll` only helps if the teardown path
  // actually calls it. index.mjs routes stdin-end / SIGTERM / SIGINT here.
  const { server } = makeServer()
  const pending = server.peer.request('host/z', {})
  const realExit = process.exit
  process.exit = () => {} // shutdown() schedules a real exit 250ms later
  server.shutdown()
  let err = null
  try { await pending } catch (e) { err = e }
  process.exit = realExit
  check('shutdown released the caller', !!err, err?.message ?? '')
  check('nothing left pending', server.peer.pendingCount === 0)
}

console.log('\n── T6: a response to an id we never asked about is ignored ──')
{
  const { send, out } = makeServer()
  await send({ jsonrpc: '2.0', id: 999999, result: {} })
  await sleep(10)
  check('no reply, no throw', out.length === 0, `emitted ${out.length}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? '✅ all' : `❌ ${failed.length} of`} ${results.length} checks`)
process.exit(failed.length === 0 ? 0 : 1)
