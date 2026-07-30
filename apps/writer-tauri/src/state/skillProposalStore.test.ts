// Accepting a skill proposal wrote SKILL.md straight to disk, which is wrong
// in two ways once that file is a scanned, editable note (it is — a nested
// `_system/agent/skills/<dir>/SKILL.md` falls through scanVault's recognised
// folders to a generic `note`).
//
// 1. `composeFrontmatter` REPLACES the whole frontmatter block, so any key the
//    file carried that the accept path doesn't know about is destroyed.
// 2. If the skill is open in the editor, the direct write is echo-suppressed
//    and the handle's mirror still holds the old body — so the next flush
//    writes the old body back over the accepted skill. The user is told
//    "saved" and the skill quietly reverts.
//
// This is the same root cause as the rename bug, pointing the other way:
// rename pushed stale disk INTO the editor; this lets the editor overwrite
// disk afterwards.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  handles: {} as Record<string, { bodyMarkdown: string; contentReady: Promise<void> }>,
  knownDocs: [] as unknown[],
  conflict: false,
  writeVaultFile: vi.fn(),
  setDocProperty: vi.fn(() => true),
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
  vaultFileExists: async (p: string) => state.disk.has(p),
}))
vi.mock('@/state/docsStore', () => ({
  useDocsStore: {
    getState: () => ({
      knownDocs: state.knownDocs,
      handles: state.handles,
      ensureHandle: state.ensureHandle,
      setDocProperty: state.setDocProperty,
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
import { useSkillProposalStore } from './skillProposalStore'

const REL = '_system/agent/skills/inbox-to-wiki/SKILL.md'
// A real skill from this vault: `description` plus a key the accept path knows
// nothing about. The latter is what a whole-block rewrite silently drops.
const ON_DISK = [
  '---',
  'description: old when-to-use',
  'tags:',
  '  - agent',
  '---',
  '',
  'old procedure',
  '',
].join('\n')

const proposal = {
  pendingId: 'p1',
  runId: 'r1',
  name: 'inbox-to-wiki',
  description: 'new when-to-use',
  body: 'new procedure',
  updates: 'inbox-to-wiki',
}

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
  state.disk = new Map([[REL, ON_DISK]])
  state.handles = {}
  // A nested `_system/**` markdown file is a generic `note` — scanVault's
  // `system:` rule only matches `_system/<name>.md` at one level.
  state.knownDocs = [{ slug: 'skill-doc', type: 'note', title: 'SKILL', relPath: REL }]
  state.conflict = false
  state.writeVaultFile.mockClear()
  state.setDocProperty.mockClear()
  state.markSlugDirty.mockClear()
  state.flushDirty.mockClear()
  useSkillProposalStore.setState({ byId: {} })
  useSkillProposalStore.getState().push(proposal)
})

afterEach(() => unregisterCmEditor('skill-doc'))

describe('useSkillProposalStore.accept', () => {
  it('updating a skill keeps frontmatter it does not own', async () => {
    expect(await useSkillProposalStore.getState().accept('p1')).toBe(true)

    const written = state.disk.get(REL)!
    expect(written).toContain('description: new when-to-use')
    expect(written).toContain('new procedure')
    expect(written).toContain('- agent') // the key the accept path never knew about
  })

  it('lands in the open editor instead of behind it', async () => {
    state.handles = {
      'skill-doc': { bodyMarkdown: 'old procedure', contentReady: Promise.resolve() },
    }
    const buf = mountEditor('skill-doc', 'old procedure')

    expect(await useSkillProposalStore.getState().accept('p1')).toBe(true)

    // The flush is the only disk writer once a handle exists — writing here
    // is what the mirror later overwrites.
    expect(buf.text).toBe('new procedure')
    expect(state.markSlugDirty).toHaveBeenCalledWith('skill-doc')
    expect(state.writeVaultFile).not.toHaveBeenCalled()
    expect(state.setDocProperty).toHaveBeenCalledWith(
      'skill-doc',
      'description',
      'new when-to-use',
    )
  })

  it('still creates a brand-new skill straight to disk', async () => {
    state.disk = new Map() // nothing there yet
    state.knownDocs = []

    expect(await useSkillProposalStore.getState().accept('p1')).toBe(true)

    const written = state.disk.get(REL)!
    expect(written).toContain('name: inbox-to-wiki')
    expect(written).toContain('description: new when-to-use')
    expect(written).toContain('new procedure')
  })
})
