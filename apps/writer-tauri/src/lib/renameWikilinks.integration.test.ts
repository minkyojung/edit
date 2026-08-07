// Renaming a note rewrites `[[OldTitle]]` in every other note. That rewrite
// used to be computed from DISK — so for a note the user had open with
// keystrokes not yet flushed, it read a stale body, wrote the stale body back
// with the link swapped, and then pushed that disk copy into the live editor
// via reloadFromVault. The unsaved keystrokes were gone, with no error.
//
// These drive the real `updateDocBody` funnel and the real activeCmEditor
// registry — `registerCmEditor`'s `getBody` IS the seam that makes "unsaved
// text exists" true, so the test asserts through the product's own bridge
// rather than restating what "unsaved" means.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  handles: {} as Record<string, { bodyMarkdown: string; contentReady: Promise<void> }>,
  knownDocs: [] as unknown[],
  conflict: false,
  writeVaultFile: vi.fn(),
  reloadFromVault: vi.fn(),
  ensureHandle: vi.fn(),
  markSlugDirty: vi.fn(),
  clearDirty: vi.fn(),
  flushDirty: vi.fn(),
}))

vi.mock('@/lib/vault', () => ({
  readVaultFile: async (p: string) => {
    const v = state.disk.get(p)
    if (v === undefined) throw new Error(`ENOENT ${p}`)
    return v
  },
  writeVaultFile: async (p: string, c: string) => {
    state.writeVaultFile(p, c)
    state.disk.set(p, c)
  },
}))
vi.mock('@/state/docsStore', () => ({
  useDocsStore: {
    getState: () => ({
      knownDocs: state.knownDocs,
      handles: state.handles,
      reloadFromVault: state.reloadFromVault,
      ensureHandle: state.ensureHandle,
    }),
  },
}))
vi.mock('@/state/externalConflictStore', () => ({
  hasExternalConflict: () => state.conflict,
}))
vi.mock('@/lib/docFileSync', () => ({
  markSlugDirty: (...a: unknown[]) => state.markSlugDirty(...(a as [])),
  clearDirty: (...a: unknown[]) => state.clearDirty(...(a as [])),
  flushDirty: (...a: unknown[]) => state.flushDirty(...(a as [])),
}))

import { registerCmEditor, unregisterCmEditor } from '@/state/activeCmEditor'
import { updateWikilinksForRename } from './renameWikilinks'

const LINKER = 'inbox/Linker.md'
const ON_DISK = '---\nslug: linker\ntags: [x]\n---\n\nsee [[Tom]]\n'

/** The renamed note plus one other note that links to it. Both are plain
 *  `note`s so the real `pathForDoc` resolves them from `relPath`. */
const docs = [
  { slug: 'renamed', type: 'note', title: 'Thomas', relPath: 'wiki/Thomas.md' },
  { slug: 'linker', type: 'note', title: 'Linker', relPath: LINKER },
]

/** Mount a CM editor on `slug` whose buffer holds `body`, and report what the
 *  buffer says afterwards. This is the only way "unsaved" is expressible: the
 *  editor's `getBody` is what `pullActiveCmBody` reads. */
function mountEditor(slug: string, body: string) {
  const buf = { text: body }
  registerCmEditor({
    slug,
    getBody: () => buf.text,
    setBody: (md) => {
      buf.text = md
    },
    rejectChange: () => {},
    scrollToChange: () => {},
    isMaterialized: () => false,
  })
  return buf
}

beforeEach(() => {
  state.disk = new Map([[LINKER, ON_DISK]])
  state.handles = {}
  state.knownDocs = docs
  state.conflict = false
  state.writeVaultFile.mockClear()
  state.reloadFromVault.mockClear()
  state.ensureHandle.mockClear()
  state.markSlugDirty.mockClear()
  state.clearDirty.mockClear()
  state.flushDirty.mockClear()
})

afterEach(() => unregisterCmEditor('linker'))

describe('updateWikilinksForRename', () => {
  it('rewrites the link WITHOUT discarding the open editor’s unsaved text', async () => {
    state.handles = {
      linker: { bodyMarkdown: 'see [[Tom]]', contentReady: Promise.resolve() },
    }
    const buf = mountEditor('linker', 'see [[Tom]] and my UNSAVED sentence')

    await updateWikilinksForRename('renamed', 'Tom', 'Thomas')

    // Both halves in one assertion on purpose: rewriting from disk gets the
    // link right and loses the sentence, so an assertion on either half alone
    // could pass against the broken code.
    expect(buf.text).toBe('see [[Thomas]] and my UNSAVED sentence')
    expect(state.handles.linker.bodyMarkdown).toBe(
      'see [[Thomas]] and my UNSAVED sentence',
    )
    // The flush is the only disk writer for a doc that has a handle.
    expect(state.markSlugDirty).toHaveBeenCalledWith('linker')
    expect(state.writeVaultFile).not.toHaveBeenCalled()
    expect(state.reloadFromVault).not.toHaveBeenCalled()
  })

  it('declines a doc with an unresolved external conflict instead of clobbering it', async () => {
    state.handles = {
      linker: { bodyMarkdown: 'see [[Tom]]', contentReady: Promise.resolve() },
    }
    const buf = mountEditor('linker', 'see [[Tom]] mine')
    state.conflict = true

    await updateWikilinksForRename('renamed', 'Tom', 'Thomas')

    expect(buf.text).toBe('see [[Tom]] mine')
    expect(state.writeVaultFile).not.toHaveBeenCalled()
    expect(state.markSlugDirty).not.toHaveBeenCalled()
  })

  // NOT a red-first test — this passes today. It guards the trap in the fix:
  // routing EVERY note through updateDocBody would call ensureHandle on each,
  // and buildHandle marks the slug dirty, calls markEdited, and never frees the
  // handle. Verified red by deleting the `handles[slug]` gate.
  it('writes a closed note straight to disk, allocating no handle', async () => {
    await updateWikilinksForRename('renamed', 'Tom', 'Thomas')

    const written = state.disk.get(LINKER)!
    expect(written).toContain('[[Thomas]]')
    expect(written).toContain('slug: linker') // frontmatter preserved verbatim
    expect(written).toContain('tags:')
    expect(state.ensureHandle).not.toHaveBeenCalled()
    expect(state.markSlugDirty).not.toHaveBeenCalled()
  })
})
