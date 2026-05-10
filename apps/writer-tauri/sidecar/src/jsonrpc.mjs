// LSP-style framing + JSON-RPC 2.0 encode/decode. See ../PROTOCOL.md.

const HEADER_END = Buffer.from('\r\n\r\n')

export function encode(message) {
  const json = JSON.stringify(message)
  const body = Buffer.from(json, 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}

// Stateful framing parser. Feed bytes via push(); pull complete messages
// via shift(). Handles partial reads and multiple messages in one chunk.
export class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0)
    this.queue = []
  }

  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    this.#drain()
  }

  shift() {
    return this.queue.shift()
  }

  #drain() {
    while (true) {
      const headerEnd = this.buf.indexOf(HEADER_END)
      if (headerEnd < 0) return

      const headerStr = this.buf.slice(0, headerEnd).toString('ascii')
      const match = headerStr.match(/Content-Length:\s*(\d+)/i)
      if (!match) {
        // Malformed header — discard up to the separator and try again.
        this.buf = this.buf.slice(headerEnd + HEADER_END.length)
        continue
      }

      const contentLength = Number(match[1])
      const totalLength = headerEnd + HEADER_END.length + contentLength
      if (this.buf.length < totalLength) return

      const body = this.buf.slice(headerEnd + HEADER_END.length, totalLength)
      this.buf = this.buf.slice(totalLength)

      try {
        this.queue.push(JSON.parse(body.toString('utf8')))
      } catch {
        // Parse error — push a placeholder so server can return -32700.
        this.queue.push({ __parseError: true, raw: body.toString('utf8') })
      }
    }
  }
}

// JSON-RPC 2.0 helpers.

export function response(id, result) {
  return { jsonrpc: '2.0', id, result }
}

export function errorResponse(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id, error }
}

export function notification(method, params) {
  return { jsonrpc: '2.0', method, params }
}

// Standard JSON-RPC error codes
export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603

// Domain codes
export const BUSY = -32001
export const NOT_INITIALIZED = -32002
export const NO_TOKEN = -32003
export const INVALID_TOKEN = -32004
