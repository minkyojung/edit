// Audit C2: the async image "upgrade" write must not clobber a NEWER copy. Copy A has a
// slow embed; copy B happens before A's embed resolves; A resolving late used to overwrite
// the clipboard with A's (now stale) content over B's. A generation counter makes the
// latest copy win. We mock embedLocalImages (controllable resolution) + navigator.clipboard
// and assert the late copy's upgrade does NOT write.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

vi.mock('@/lib/embedLocalImages', () => ({ embedLocalImages: vi.fn() }))
import { embedLocalImages } from '@/lib/embedLocalImages'
import { richTextCopy } from './cmRichCopy'

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

type Deferred = { resolve: (html: string) => void; html: string }
let pending: Deferred[]
let write: ReturnType<typeof vi.fn>

beforeEach(() => {
  pending = []
  ;(embedLocalImages as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (html: string) => new Promise<string>((resolve) => pending.push({ resolve, html })),
  )
  write = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true })
  // jsdom lacks ClipboardItem; a no-op stand-in is enough for the write path.
  ;(globalThis as { ClipboardItem?: unknown }).ClipboardItem = class {
    constructor(_items: unknown) {}
  }
})

function fireCopy(view: EditorView) {
  const ev = new Event('copy', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
  ev.clipboardData = { setData: () => {}, getData: () => '' }
  view.contentDOM.dispatchEvent(ev)
}

describe('richTextCopy — a stale async upgrade cannot clobber a newer copy (C2)', () => {
  it('the earlier copy, resolving last, does not write over the newer copy', async () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: '![](img.png) hello', selection: { anchor: 0, head: 18 }, extensions: [richTextCopy] }),
    })

    fireCopy(view) // copy A → embed pending[0]
    fireCopy(view) // copy B → embed pending[1]
    expect(pending).toHaveLength(2)

    // B's embed resolves first and writes (it's the current generation).
    pending[1].resolve(pending[1].html + '<!--embedded-->')
    await flush()
    expect(write).toHaveBeenCalledTimes(1)

    // A's embed resolves LATE — it must bail (stale generation), not clobber B.
    pending[0].resolve(pending[0].html + '<!--embedded-->')
    await flush()
    expect(write).toHaveBeenCalledTimes(1) // still once — A did not write

    view.destroy()
  })
})
