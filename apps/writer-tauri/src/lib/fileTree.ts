// Catalog → folder/file tree.
//
// Turns the flat `knownDocs` catalog into the nested folder structure the
// (Obsidian-style) sidebar tree renders. Each doc is placed at its
// on-disk path (pathForDoc); the folders are synthesised from the path
// segments. Pure — no I/O, no store — so the tree shape is unit-testable
// before any UI exists.
//
// This builds from the CATALOG, so it currently shows only the folders
// the catalog recognises (daily/wiki/inbox/articles/_system). Once
// scanVault is generalised to include every `.md`, arbitrary user folders
// flow through here unchanged — only the node count grows.

import type { KnownDoc } from '@/state/docsStore'
import { pathForDoc } from '@/lib/docPaths'

export interface TreeFile {
  kind: 'file'
  /** Display name — the filename without its `.md` extension. */
  name: string
  /** Vault-relative path of the file (e.g. `wiki/Tom.md`). */
  path: string
  /** The doc to open when the row is clicked. */
  slug: string
  /** Doc type, for icon selection in the renderer. */
  type: KnownDoc['type']
}

export interface TreeFolder {
  kind: 'folder'
  name: string
  /** Vault-relative folder path (e.g. `daily/2026-06-10`). */
  path: string
  children: TreeNode[]
}

export type TreeNode = TreeFile | TreeFolder

/** Build the sidebar tree from the catalog. Archived docs and docs with
 *  no placement (e.g. a daily without a date) are dropped. Folders sort
 *  before files, each alphabetically (case-insensitive). */
export function buildFileTree(docs: KnownDoc[]): TreeNode[] {
  const bySlug = new Map(docs.map((d) => [d.slug, d]))
  const getDoc = (slug: string) => bySlug.get(slug)
  const rootChildren: TreeNode[] = []

  for (const doc of docs) {
    if (doc.archivedAt) continue
    const path = pathForDoc(doc, getDoc)
    if (!path) continue

    const segments = path.split('/')
    const fileName = segments.pop() ?? path // last segment is the file

    // Descend into (creating as needed) the folder chain.
    let children = rootChildren
    let acc = ''
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg
      let folder = children.find(
        (c): c is TreeFolder => c.kind === 'folder' && c.name === seg,
      )
      if (!folder) {
        folder = { kind: 'folder', name: seg, path: acc, children: [] }
        children.push(folder)
      }
      children = folder.children
    }

    children.push({
      kind: 'file',
      name: fileName.replace(/\.md$/, ''),
      path,
      slug: doc.slug,
      type: doc.type,
    })
  }

  sortNodes(rootChildren)
  return rootChildren
}

/** Folders first, then files; each group alphabetical, case-insensitive.
 *  Recurses into folder children. */
function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  for (const n of nodes) if (n.kind === 'folder') sortNodes(n.children)
}
