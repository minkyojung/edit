// A sidecar that does nothing but answer `initialize`, with whatever
// protocolVersion argv[2] says. Stands in for a stale `sidecar-pkg/`.
//
// `omit` reports no version at all — the older-than-the-field case, which
// deserialises to `None` rather than to a wrong number.

const want = process.argv[2]
let buf = Buffer.alloc(0)

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const split = buf.indexOf('\r\n\r\n')
    if (split === -1) return
    const header = buf.subarray(0, split).toString('utf8')
    const len = Number(/content-length:\s*(\d+)/i.exec(header)?.[1])
    if (!Number.isFinite(len) || buf.length < split + 4 + len) return
    const body = buf.subarray(split + 4, split + 4 + len).toString('utf8')
    buf = buf.subarray(split + 4 + len)

    const msg = JSON.parse(body)
    if (msg.method !== 'initialize' || msg.id === undefined) continue
    const result = { mode: 'chat' }
    if (want !== 'omit') result.protocolVersion = Number(want)
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), 'utf8')
    process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`)
    process.stdout.write(payload)
  }
})
