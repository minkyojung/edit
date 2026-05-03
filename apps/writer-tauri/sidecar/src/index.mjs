// Entry. Wires stdin/stdout to the JSON-RPC server.
//
// Usage: node src/index.mjs --mode=chat | --mode=title

import { FrameParser, encode } from './jsonrpc.mjs'
import { Server } from './server.mjs'

function parseMode(argv) {
  const arg = argv.find((a) => a.startsWith('--mode='))
  if (!arg) {
    process.stderr.write('missing --mode=chat|title\n')
    process.exit(2)
  }
  const mode = arg.slice('--mode='.length)
  if (mode !== 'chat' && mode !== 'title') {
    process.stderr.write(`invalid --mode (got ${mode})\n`)
    process.exit(2)
  }
  return mode
}

const mode = parseMode(process.argv.slice(2))
const parser = new FrameParser()

const server = new Server({
  mode,
  emit: (msg) => {
    try {
      process.stdout.write(encode(msg))
    } catch (err) {
      process.stderr.write(`emit error: ${err?.message ?? err}\n`)
    }
  },
})

// Bun's `process.stdin.on('data', ...)` does not fire when the parent is a
// Tokio-spawned child process (it works fine with Node-spawned children and
// shell pipes, but Tokio's pipe configuration exposes a bun bug). Bypass the
// runtime stream layer with a low-level fs.readSync poll on fd 0; non-blocking
// reads return EAGAIN when no data is available, so we sleep briefly and
// retry. Node honors this same API path, so dev mode (system node) works
// identically.
import fs from 'node:fs'
const buf = Buffer.alloc(64 * 1024)
async function consumeStdin() {
  while (true) {
    let n
    try {
      n = fs.readSync(0, buf, 0, buf.length, null)
    } catch (err) {
      if (err && err.code === 'EAGAIN') {
        await new Promise((r) => setTimeout(r, 10))
        continue
      }
      process.stderr.write(`stdin read err: ${err?.message ?? err}\n`)
      return
    }
    if (n === 0) return // EOF — parent closed our stdin
    parser.push(buf.subarray(0, n))
    while (true) {
      const msg = parser.shift()
      if (!msg) break
      // Fire-and-forget; handle() resolves once the synchronous part is done
      // and any streaming continues asynchronously via emit().
      server.handle(msg)
    }
  }
}

consumeStdin()
  .catch((err) => {
    process.stderr.write(`stdin loop error: ${err?.message ?? err}\n`)
    process.exit(1)
  })
  .finally(() => process.exit(0))

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

process.stderr.write(`[sidecar] mode=${mode} pid=${process.pid} ready\n`)
