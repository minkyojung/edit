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

process.stdin.on('data', (chunk) => {
  parser.push(chunk)
  while (true) {
    const msg = parser.shift()
    if (!msg) break
    // Fire-and-forget; handle() resolves once the synchronous part is done
    // and any streaming continues asynchronously via emit().
    server.handle(msg)
  }
})

process.stdin.on('end', () => {
  // Parent closed our stdin — quit gracefully.
  process.exit(0)
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

process.stderr.write(`[sidecar] mode=${mode} pid=${process.pid} ready\n`)
