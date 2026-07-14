// Integration check for the two derived views (U7 index, U8 timeline,
// U11 knowledge-base setting). The pure functions are unit-tested
// elsewhere; this drives the REAL buildWikiIndex / buildVaultTimeline
// orchestrators against a realistic multi-folder vault — exercising the
// store wiring, the setting reads, backlink counting, sidecar fallback,
// attachment + empty-folder assembly, and folder ordering end-to-end.
//
// The GUI can't verify these (the pages are hidden from the app), and
// they only run inside the Tauri runtime, so this mocked-store harness
// is the closest observable "does it actually run" we have short of a
// full dogfood boot.

import { describe, it, expect, vi } from 'vitest'

// A realistic vault: knowledge base (wiki), capture (inbox), an imported
// nested folder with an attachment, a daily, a root note, an empty
// folder, plus a system page that must NOT appear.
const { state, bodies } = vi.hoisted(() => ({
  state: {
    knownDocs: [
      { slug: 'w1', type: 'wiki:custom-w1', title: 'Sarah' },
      { slug: 'w2', type: 'wiki:custom-w2', title: 'GraphQL' },
      { slug: 'i1', type: 'note', title: 'Clip', relPath: 'inbox/Clip.md' },
      {
        slug: 'r1',
        type: 'note',
        title: 'Paper',
        relPath: 'research/2024/Paper.md',
        createdAt: '2026-07-13T10:00:00.000Z',
      },
      { slug: 'd1', type: 'daily', date: '2026-07-12', createdAt: '2026-07-12T09:00:00.000Z' },
      { slug: 'c1', type: 'note', title: 'CLAUDE', relPath: 'CLAUDE.md' },
      { slug: 's1', type: 'system:index', title: 'index' },
    ],
    knownFolders: [
      'wiki', 'inbox', 'research', 'research/2024', 'daily',
      'drafts', '_system', 'threads',
    ],
    knownFiles: ['research/2024/paper.pdf'],
    // Overridden in the setting-change test; undefined → default 'wiki'.
    knowledgeBaseFolder: undefined as string | undefined,
  },
  // w1 (Sarah) links to [[GraphQL]] → one backlink onto w2, and gives a
  // content line for the summary excerpt.
  bodies: {
    w1: 'Sarah\n\nSenior engineer. Works on [[GraphQL]].',
    w2: 'GraphQL\n\nAPI query language.',
  } as Record<string, string>,
}))

vi.mock('@/state/docsStore', () => ({
  useDocsStore: { getState: () => state },
}))
vi.mock('@/lib/vault', () => ({
  // No sidecars on disk → summaries fall back to the body excerpt.
  vaultFileExists: async () => false,
  readVaultFile: async () => '',
  writeVaultFile: async () => {},
}))
vi.mock('./settingsStore', () => ({
  getKnowledgeBaseFolder: () => state.knowledgeBaseFolder ?? 'wiki',
  getDefaultNoteFolder: () => 'inbox',
}))
vi.mock('./wikiService', () => ({
  readWikiMarkdown: (slug: string) => bodies[slug] ?? '',
  ensureIndexWikiSlug: async () => null,
  ensureTimelineWikiSlug: async () => null,
}))

import { buildWikiIndex } from './wikiIndex'
import { buildVaultTimeline } from './vaultTimeline'

describe('buildWikiIndex — whole-vault map (integration)', () => {
  it('groups notes by folder with knowledge base first, capture second', async () => {
    const out = await buildWikiIndex()
    // Knowledge base (wiki) is the top section, capture (inbox) next.
    expect(out.indexOf('## wiki/ — knowledge base')).toBeGreaterThanOrEqual(0)
    expect(out.indexOf('## wiki/ — knowledge base')).toBeLessThan(
      out.indexOf('## inbox/ — capture'),
    )
    expect(out.indexOf('## inbox/ — capture')).toBeLessThan(
      out.indexOf('## research/2024/'),
    )
    // Daily collapses into one section, ordered last of the note sections.
    expect(out).toContain('## daily/ (1)')
  })

  it('counts backlinks and renders the summary excerpt', async () => {
    const out = await buildWikiIndex()
    // GraphQL has one inbound link (from Sarah); excerpt from its body.
    expect(out).toContain('| wiki/GraphQL.md | GraphQL | API query language. | 1 |')
    // Sarah has no inbound link.
    expect(out).toContain('| wiki/Sarah.md | Sarah | Senior engineer. Works on [[GraphQL]]. | 0 |')
  })

  it('surfaces attachments, empty folders, and the root section', async () => {
    const out = await buildWikiIndex()
    expect(out).toContain('**Attachments**')
    expect(out).toContain('- research/2024/paper.pdf')
    expect(out).toContain('## drafts/ (0)')
    expect(out).toContain('_(empty folder)_')
    expect(out).toContain('## / (1)') // CLAUDE.md at the vault root
  })

  it('excludes system pages', async () => {
    const out = await buildWikiIndex()
    expect(out).not.toContain('_system')
    expect(out).not.toContain('| index ')
  })

  it('re-labels + top-sorts the knowledge base when the setting changes', async () => {
    // Point the knowledge base at a folder that holds notes directly
    // (inbox), the way a real knowledge-base folder does. The label and
    // top-sort follow the setting; wiki drops to a plain section.
    state.knowledgeBaseFolder = 'inbox'
    const out = await buildWikiIndex()
    expect(out).toContain('## inbox/ — knowledge base')
    expect(out).not.toContain('## wiki/ — knowledge base')
    // The re-labeled section sorts to the top.
    expect(out.indexOf('## inbox/ — knowledge base')).toBeLessThan(
      out.indexOf('## wiki/'),
    )
    state.knowledgeBaseFolder = undefined // restore default for later runs
  })
})

describe('buildVaultTimeline — by-date ledger (integration)', () => {
  it('orders dated notes newest-first with an Undated tail', async () => {
    const out = await buildVaultTimeline()
    const iPaper = out.indexOf('## 2026-07-13')
    const iDaily = out.indexOf('## 2026-07-12')
    const iUndated = out.indexOf('## Undated')
    expect(iPaper).toBeGreaterThanOrEqual(0)
    expect(iPaper).toBeLessThan(iDaily) // newer day first
    expect(iDaily).toBeLessThan(iUndated) // Undated last
    // The dated notes land on their day.
    expect(out).toContain('- `research/2024/Paper.md` — Paper')
    // Notes with no createdAt fall into Undated, not dropped.
    expect(out.slice(iUndated)).toContain('- `wiki/Sarah.md` — Sarah')
  })
})
