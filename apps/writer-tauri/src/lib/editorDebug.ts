// Editor observability — central debug bus for the writer-tauri app.
//
// Purpose: the editor sits on top of a 4-layer stack (React UI →
// Milkdown → ProseMirror → Yjs/Hocuspocus), and a single user action
// can produce a cascade of events across all four layers. When
// something goes wrong, "what just happened?" is the hardest question
// to answer from the outside. This module funnels events from every
// layer into one timestamped ring buffer and exposes a single dump
// command (`__editorDump()`) that returns the full picture in one
// JSON blob.
//
// What gets captured automatically once `bootstrapEditorDebug()` is
// called:
//
//   - console.error / console.warn (original behavior preserved)
//   - window.onerror (uncaught throws)
//   - unhandledrejection (uncaught promise rejections)
//
// What gets captured via explicit calls to `dbg(category, msg, data?)`:
//
//   - PM transactions (see editor/debugPlugin.ts)
//   - Yjs provider events (see state/docsStore.ts)
//   - Migration steps (see lib/docTitle.ts when wired)
//   - Anything else worth marking — call dbg from any code path
//
// Dev-console API:
//
//   __editorDump()    → console.log the full snapshot, also returns it
//   __editorCopy()    → copy the snapshot JSON to the clipboard
//   __editorEvents(n) → last n events only (default 50)
//   __editorErrors()  → only events in the 'error' or 'console' (with
//                       msg === 'error') category
//   __editorClear()   → empty the ring buffer (state contributors
//                       remain registered)

const BUFFER_MAX = 500

interface DebugEvent {
  ts: number
  category: string
  msg: string
  data?: unknown
}

let buffer: DebugEvent[] = []
let droppedCount = 0

function push(evt: DebugEvent): void {
  buffer.push(evt)
  if (buffer.length > BUFFER_MAX) {
    buffer.shift()
    droppedCount += 1
  }
}

// safeClone — strip non-serializable junk so JSON.stringify in the
// dump doesn't throw on circular refs / functions / DOM nodes / Yjs
// internals. Falls back to a placeholder string on hopeless cases.
function safeClone(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'
  if (v === null || v === undefined) return v
  if (typeof v === 'function') return '[function]'
  if (typeof v !== 'object') return v
  // DOM / Y.Doc / provider — recognize by constructor name and skip
  const ctor = (v as { constructor?: { name?: string } }).constructor?.name
  if (
    ctor === 'Y.Doc' ||
    ctor === 'YDoc' ||
    ctor === 'HocuspocusProvider' ||
    ctor === 'EditorView' ||
    ctor === 'EditorState' ||
    (typeof Node !== 'undefined' && v instanceof Node)
  ) {
    return `[${ctor}]`
  }
  if (Array.isArray(v)) {
    return v.slice(0, 50).map((item) => safeClone(item, depth + 1))
  }
  const out: Record<string, unknown> = {}
  let keyCount = 0
  for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
    if (keyCount >= 30) {
      out['...'] = `[${Object.keys(v as object).length - 30} more keys]`
      break
    }
    try {
      out[key] = safeClone(val, depth + 1)
    } catch {
      out[key] = '[clone-failed]'
    }
    keyCount += 1
  }
  return out
}

export function dbg(category: string, msg: string, data?: unknown): void {
  const evt: DebugEvent = { ts: Date.now(), category, msg }
  if (data !== undefined) evt.data = safeClone(data)
  push(evt)
}

export function getEvents(): DebugEvent[] {
  return [...buffer]
}

export function clearEvents(): void {
  buffer = []
  droppedCount = 0
}

// Snapshot contributors — modules register a function that produces
// a slice of state to include in __editorDump(). Each runs at dump
// time inside a try/catch so a thrown contributor can't poison the
// whole dump.
type SnapshotContributor = () => unknown
const contributors = new Map<string, SnapshotContributor>()

export function registerSnapshotContributor(
  name: string,
  fn: SnapshotContributor,
): void {
  contributors.set(name, fn)
}

export function unregisterSnapshotContributor(name: string): void {
  contributors.delete(name)
}

function buildDump(): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  for (const [name, fn] of contributors) {
    try {
      state[name] = safeClone(fn())
    } catch (err) {
      state[name] = `[contributor-error: ${String(err)}]`
    }
  }
  return {
    ts: Date.now(),
    bufferDropped: droppedCount,
    bufferSize: buffer.length,
    state,
    events: getEvents(),
  }
}

let captureInstalled = false
function installGlobalCaptures(): void {
  if (captureInstalled) return
  captureInstalled = true

  const origError = console.error
  console.error = function (...args: unknown[]) {
    try {
      push({ ts: Date.now(), category: 'console', msg: 'error', data: safeClone(args) })
    } catch {
      /* never block real logging */
    }
    return origError.apply(this, args as Parameters<typeof console.error>)
  }

  const origWarn = console.warn
  console.warn = function (...args: unknown[]) {
    try {
      push({ ts: Date.now(), category: 'console', msg: 'warn', data: safeClone(args) })
    } catch {
      /* never block real logging */
    }
    return origWarn.apply(this, args as Parameters<typeof console.warn>)
  }

  window.addEventListener('error', (e) => {
    push({
      ts: Date.now(),
      category: 'error',
      msg: 'window.onerror',
      data: {
        message: e.message,
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno,
        stack: (e.error as Error | undefined)?.stack,
      },
    })
  })

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as { message?: string; stack?: string } | string | undefined
    push({
      ts: Date.now(),
      category: 'error',
      msg: 'unhandledrejection',
      data: {
        reason: String(reason),
        stack: typeof reason === 'object' ? reason?.stack : undefined,
      },
    })
  })
}

let windowInstalled = false
function installWindowAPI(): void {
  if (windowInstalled) return
  windowInstalled = true
  const w = window as unknown as Record<string, unknown>
  w.__editorDump = () => {
    const d = buildDump()
    console.log('[editorDebug] dump:', d)
    return d
  }
  w.__editorCopy = async () => {
    const d = buildDump()
    const text = JSON.stringify(d, null, 2)
    try {
      await navigator.clipboard.writeText(text)
      console.log(`[editorDebug] Copied ${text.length} chars to clipboard`)
    } catch (err) {
      console.error('[editorDebug] clipboard write failed', err)
      console.log('[editorDebug] dump (raw):', text)
    }
    return text
  }
  w.__editorEvents = (n = 50) => {
    const ev = getEvents()
    return ev.slice(Math.max(0, ev.length - n))
  }
  w.__editorErrors = () =>
    getEvents().filter(
      (e) => e.category === 'error' || (e.category === 'console' && e.msg === 'error'),
    )
  w.__editorClear = () => {
    clearEvents()
    console.log('[editorDebug] Buffer cleared')
  }
}

// Single entry point called from main.tsx at boot. Idempotent.
export function bootstrapEditorDebug(): void {
  installGlobalCaptures()
  installWindowAPI()
  dbg('lifecycle', 'editorDebug bootstrapped')
}
