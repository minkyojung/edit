// Entry. Wires stdin/stdout to the JSON-RPC server.
//
// Runtime: bun (prod, bundled in the .app) or system node (dev). Both
// honor the same stream-event API, so this file is runtime-agnostic.

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

// Graceful teardown on every exit trigger: abort in-flight chats so the SDK
// reaps its `claude` CLI child (no orphan) and flushes the session (resume
// stays intact), then exit. Bare `process.exit(0)` skipped that, leaving the
// grandchild running when the host killed us.
process.stdin.on('end', () => server.shutdown())
process.on('SIGTERM', () => server.shutdown())
process.on('SIGINT', () => server.shutdown())

// Last-chance diagnostics. Unhandled errors in async code paths inside the
// SDK / our handlers would otherwise tear down the process with no stderr
// trace — making post-mortem debugging blind. Both handlers exit non-zero
// so the Rust supervisor's death-handling path still fires (transitioning the
// sidecar to restarting/dead) and the user sees the standard error card.
process.on('uncaughtException', (err) => {
  process.stderr.write(`[sidecar FATAL] uncaughtException: ${err?.stack ?? err}\n`)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  process.stderr.write(`[sidecar FATAL] unhandledRejection: ${detail}\n`)
  process.exit(1)
})

process.stderr.write(`[sidecar] mode=${mode} pid=${process.pid} ready\n`)
