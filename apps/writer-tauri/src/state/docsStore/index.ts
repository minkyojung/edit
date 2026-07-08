// Multi-document tab registry. Top-level facade that combines the
// slice files in this directory into one zustand store.
//
// Path C invariant: the vault folder is the single durable source.
// There is no IndexedDB layer — each handle's Y.Doc is built fresh
// on first open and hydrated from the .md + .ydoc pair on disk.
// `knownDocs` is derived from a vault scan at bootstrap, not
// persisted to localStorage (see scanVault.ts).
//
// Per-slice responsibilities live in each slice file's header
// docstring. This file only:
//   - imports each slice factory
//   - spreads them into one combined store creator
//   - wires the persist middleware via ./persistConfig
//   - re-exports the public type / helper surface so 43 external
//     consumers can keep `import { ... } from '@/state/docsStore'`
//     unchanged

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { DocsState } from './types'
import { createTabsSlice } from './tabsSlice'
import { createSidebarSlice } from './sidebarSlice'
import { createDateNavSlice } from './dateNavSlice'
import { createEditSlice } from './editSlice'
import { createHandlesSlice } from './handlesSlice'
import { createCreateSlice } from './createSlice'
import { createArchiveSlice } from './archiveSlice'
import { createBootstrapSlice } from './bootstrapSlice'
import { persistConfig } from './persistConfig'

export const useDocsStore = create<DocsState>()(
  persist(
    (set, get) => ({
      // Catalog state lives here at the top level — every slice
      // reads/writes it via set/get but no single slice owns it.
      knownDocs: [],
      knownFolders: [],
      knownFiles: [],

      ...createTabsSlice(set, get),
      ...createSidebarSlice(set),
      ...createDateNavSlice(set),
      ...createEditSlice(set, get),
      ...createHandlesSlice(set, get),
      ...createCreateSlice(set, get),
      ...createArchiveSlice(set, get),
      ...createBootstrapSlice(set, get),
    }),
    persistConfig,
  ),
)

// Re-export public surface for the 43 consumer files.
export type { KnownDoc, DocCategory, DocPolicy, CollabStatus } from './types'
export {
  getDocPolicy,
  isWikiDoc,
  isUserOwnedWiki,
  monthAnchorOf,
  shiftDayAnchor,
  shiftMonthAnchor,
  weekStartFor,
} from './helpers'
