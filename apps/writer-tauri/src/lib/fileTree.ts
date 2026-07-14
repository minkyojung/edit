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
import type { SortMode } from '@/state/sortStore'

/** Paths hidden from the sidebar tree: `_`-prefixed agent folders
 * (`_system/`) and every dot-prefixed folder (`.octave/` app state,
 * `.git/`, …). Mirrors Obsidian hiding `.obsidian/`. Exported so other
 * surfaces (the "Move to…" folder list) hide the same set. Catalog-derived
 * paths already drop dot-entries upstream (scanVault), so the `.`-check is
 * belt-and-braces for any raw folder/file list passed in. */
export function isHiddenTreePath(path: string): boolean {
  return path.startsWith('_') || path.startsWith('.')
}

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
  /** KIND discriminators for icon selection: a captured video has a
   *  `videoId`, a saved page has a `sourceUrl`. Both absent → plain note. */
  videoId?: string
  sourceUrl?: string
  /** Creation timestamp (ISO), carried for the `created-*` sort modes.
   *  Absent on legacy docs — those fall back to a name compare. */
  createdAt?: string
}

export interface TreeFolder {
  kind: 'folder'
  name: string
  /** Vault-relative folder path (e.g. `daily/2026-06-10`). */
  path: string
  children: TreeNode[]
  /** Folder-note fields — set when a same-named sibling note is folded into
   * this folder (e.g. `daily/2026-06-10.md` + `daily/2026-06-10/`). The row
   * both opens the note (name click) and expands its children (chevron). Absent
   * on a plain folder. */
  slug?: string
  type?: KnownDoc['type']
  createdAt?: string
}

/** A non-markdown file (pdf/png/txt/…) shown as a read-only row. No slug
 * and no Yjs doc — clicking it opens the in-app file viewer by path, not
 * the editor. `name` keeps its extension so the row reads like Finder. */
export interface TreeAttachment {
  kind: 'attachment'
  name: string
  /** Vault-relative file path (e.g. `inbox/photo.png`). */
  path: string
}

export type TreeNode = TreeFile | TreeFolder | TreeAttachment

/** Build the sidebar tree from the catalog. Archived docs and docs with
 *  no placement (e.g. a daily without a date) are dropped. Folders always
 *  sort before files; `sortMode` orders within each group (default
 *  name A→Z). */
export function buildFileTree(
  docs: KnownDoc[],
  folders: string[] = [],
  sortMode: SortMode = 'name-asc',
  files: string[] = [],
): TreeNode[] {
  const bySlug = new Map(docs.map((d) => [d.slug, d]))
  const getDoc = (slug: string) => bySlug.get(slug)
  const rootChildren: TreeNode[] = []

  // Descend into (creating as needed) the folder chain for `dirPath`,
  // returning the children array of the deepest folder. '' → root.
  function ensureFolder(dirPath: string): TreeNode[] {
    if (!dirPath) return rootChildren
    let children = rootChildren
    let acc = ''
    for (const seg of dirPath.split('/')) {
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
    return children
  }

  for (const doc of docs) {
    const path = pathForDoc(doc, getDoc)
    if (!path) continue
    if (isHiddenTreePath(path)) continue

    const segments = path.split('/')
    const fileName = segments.pop() ?? path // last segment is the file
    const children = ensureFolder(segments.join('/'))

    children.push({
      kind: 'file',
      name: fileName.replace(/\.md$/, ''),
      path,
      slug: doc.slug,
      type: doc.type,
      videoId: doc.videoId,
      sourceUrl: doc.sourceUrl,
      createdAt: doc.createdAt,
    })
  }

  // Folders that exist on disk but hold no file still get a node, so the
  // user can see and target empty folders (Obsidian keeps them too).
  for (const dir of folders) {
    if (!dir || isHiddenTreePath(dir)) continue
    ensureFolder(dir)
  }

  // Non-markdown attachments — read-only rows at their on-disk path. The
  // filename keeps its extension so the row reads like Finder.
  for (const rel of files) {
    if (!rel || isHiddenTreePath(rel)) continue
    const segments = rel.split('/')
    const fileName = segments.pop() ?? rel
    const children = ensureFolder(segments.join('/'))
    children.push({ kind: 'attachment', name: fileName, path: rel })
  }

  mergeFolderNotes(rootChildren)
  sortNodes(rootChildren, sortMode)
  return rootChildren
}

/** Fold each note into a same-named sibling folder (the "folder-note" pattern).
 * The app's own layout puts a daily journal at `daily/2026-06-10.md` and that
 * day's captures under `daily/2026-06-10/` — two siblings with the same name.
 * Rendered separately they read as a confusing duplicate, so here the note is
 * absorbed into the folder: the folder row gains the note's slug (name-click
 * opens the journal) while its chevron still reveals the children. Recurses so
 * nested folder-notes merge too. */
function mergeFolderNotes(nodes: TreeNode[]): void {
  const folders = new Map<string, TreeFolder>()
  for (const n of nodes) if (n.kind === 'folder') folders.set(n.name, n)
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (n.kind !== 'file') continue
    const folder = folders.get(n.name)
    if (!folder) continue
    folder.slug = n.slug
    folder.type = n.type
    folder.createdAt = n.createdAt
    nodes.splice(i, 1)
  }
  for (const n of nodes) if (n.kind === 'folder') mergeFolderNotes(n.children)
}

/** Case-insensitive name compare (the A→Z baseline / fallback). */
function byName(a: TreeNode, b: TreeNode): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/** Compare two same-group nodes under `mode`. Folders carry no timestamp,
 *  and legacy files may lack `createdAt`, so the `created-*` modes fall
 *  back to a name compare whenever either side has no timestamp — keeping
 *  the order deterministic instead of leaving untimestamped rows to drift. */
function compareInGroup(a: TreeNode, b: TreeNode, mode: SortMode): number {
  if (mode === 'name-asc') return byName(a, b)
  if (mode === 'name-desc') return byName(b, a)
  const ta = a.kind === 'file' ? a.createdAt : undefined
  const tb = b.kind === 'file' ? b.createdAt : undefined
  if (!ta || !tb) return byName(a, b)
  // ISO timestamps are lexicographically ordered, so a string compare is
  // a correct chronological compare — no Date parsing needed.
  return mode === 'created-desc' ? tb.localeCompare(ta) : ta.localeCompare(tb)
}

/** Folders first, then files + attachments together; within a group,
 *  ordered by `mode`. Recurses into folder children. */
function sortNodes(nodes: TreeNode[], mode: SortMode): void {
  nodes.sort((a, b) => {
    const af = a.kind === 'folder'
    const bf = b.kind === 'folder'
    if (af !== bf) return af ? -1 : 1
    return compareInGroup(a, b, mode)
  })
  for (const n of nodes) if (n.kind === 'folder') sortNodes(n.children, mode)
}
