// FolderTree — Obsidian-style sidebar tree built from the catalog.
//
// Renders `buildFileTree(knownDocs)` using the same primitives the old
// DocTreeNode used (TreeRow + Collapsible + TreeSub). Folders
// expand/collapse; clicking a file opens it via the normal slug URL.
// Files can be renamed inline (double-click the name, or right-click →
// Rename) — commit on Enter/blur, cancel on Esc.
//
// Fold state is local + by folder path (not persisted yet).

import { useMemo, useRef, useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  IconBrandYoutube,
  IconChevronRight,
  IconFileText,
  IconWorld,
} from '@tabler/icons-react'
import { useDocsStore } from '@/state/docsStore'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { buildFileTree, type TreeNode } from '@/lib/fileTree'
import { buildViewUrl } from '@/lib/viewUrl'
import {
  TreeRow,
  TreeRowLabel,
  TreeRowLead,
  TreeSub,
} from '@/components/ui/tree-row'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

function FileIcon({ videoId, sourceUrl }: { videoId?: string; sourceUrl?: string }) {
  if (videoId) return <IconBrandYoutube size={16} className="text-red-500" />
  if (sourceUrl) return <IconWorld size={16} className="text-muted-foreground" />
  return <IconFileText size={16} className="text-muted-foreground" />
}

/** Inline rename input. Mounts focused with the name pre-selected.
 * Enter / blur commit, Esc cancels. A `done` latch makes the blur that
 * follows Enter/Esc a no-op so we don't commit twice or commit an
 * Esc-cancelled draft. */
function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const commit = () => {
    if (done.current) return
    done.current = true
    onCommit(value)
  }
  const cancel = () => {
    if (done.current) return
    done.current = true
    onCancel()
  }
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
      onBlur={commit}
      className="mx-2 h-6 min-w-0 flex-1 rounded-sm border border-sidebar-border bg-sidebar px-1 text-sm text-sidebar-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-sidebar-ring/40"
    />
  )
}

interface NodeProps {
  node: TreeNode
  expanded: Set<string>
  onToggle: (path: string) => void
  onOpen: (slug: string) => void
  activeSlug: string | null
  editingSlug: string | null
  onStartRename: (slug: string) => void
  onCommitRename: (slug: string, name: string) => void
  onCancelRename: () => void
  onDelete: (slug: string) => void
}

function FolderTreeNode({
  node,
  expanded,
  onToggle,
  onOpen,
  activeSlug,
  editingSlug,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
}: NodeProps) {
  if (node.kind === 'file') {
    const isEditing = editingSlug === node.slug
    return (
      <li>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <TreeRow active={node.slug === activeSlug}>
              <TreeRowLead asChild>
                <span aria-hidden>
                  <FileIcon videoId={node.videoId} sourceUrl={node.sourceUrl} />
                </span>
              </TreeRowLead>
              {isEditing ? (
                <RenameInput
                  initial={node.name}
                  onCommit={(name) => onCommitRename(node.slug, name)}
                  onCancel={onCancelRename}
                />
              ) : (
                <TreeRowLabel
                  onClick={() => onOpen(node.slug)}
                  onDoubleClick={() => onStartRename(node.slug)}
                >
                  <span className="truncate">{node.name}</span>
                </TreeRowLabel>
              )}
            </TreeRow>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => onStartRename(node.slug)}>
              Rename
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => onDelete(node.slug)}
              className="text-destructive focus:text-destructive"
            >
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </li>
    )
  }

  const isOpen = expanded.has(node.path)
  return (
    <Collapsible asChild open={isOpen} onOpenChange={() => onToggle(node.path)}>
      <li>
        <TreeRow>
          <CollapsibleTrigger asChild>
            <TreeRowLead
              aria-label={isOpen ? 'Collapse' : 'Expand'}
              onClick={(e: MouseEvent) => e.stopPropagation()}
            >
              <IconChevronRight
                size={16}
                stroke={1.75}
                className="transition-transform"
                style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
              />
            </TreeRowLead>
          </CollapsibleTrigger>
          <TreeRowLabel onClick={() => onToggle(node.path)}>
            <span className="truncate">{node.name}</span>
          </TreeRowLabel>
        </TreeRow>
        <CollapsibleContent asChild>
          <TreeSub>
            {node.children.map((child) => (
              <FolderTreeNode
                key={child.path}
                node={child}
                expanded={expanded}
                onToggle={onToggle}
                onOpen={onOpen}
                activeSlug={activeSlug}
                editingSlug={editingSlug}
                onStartRename={onStartRename}
                onCommitRename={onCommitRename}
                onCancelRename={onCancelRename}
                onDelete={onDelete}
              />
            ))}
          </TreeSub>
        </CollapsibleContent>
      </li>
    </Collapsible>
  )
}

export function FolderTree() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const sidebarTab = useDocsStore((s) => s.sidebarTab)
  const dayAnchor = useDocsStore((s) => s.dayAnchor)
  const monthAnchor = useDocsStore((s) => s.monthAnchor)
  const renameDoc = useDocsStore((s) => s.renameDoc)
  const deleteToTrash = useDocsStore((s) => s.deleteToTrash)
  const navigate = useNavigate()
  const activeSlug = useActiveSlug()

  const tree = useMemo(() => buildFileTree(knownDocs), [knownDocs])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [editingSlug, setEditingSlug] = useState<string | null>(null)

  const onToggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  const onOpen = (slug: string) =>
    navigate(buildViewUrl({ tab: sidebarTab, dayAnchor, monthAnchor, slug }))
  const onCommitRename = (slug: string, name: string) => {
    renameDoc(slug, name) // trims / validates / de-dupes; empty is a no-op
    setEditingSlug(null)
  }
  const onDelete = (slug: string) => {
    void deleteToTrash(slug).then((next) => {
      if (next) navigate(buildViewUrl({ tab: sidebarTab, dayAnchor, monthAnchor, slug: next }))
    })
  }

  return (
    <ul className="flex flex-col px-2 py-1">
      {tree.map((node) => (
        <FolderTreeNode
          key={node.path}
          node={node}
          expanded={expanded}
          onToggle={onToggle}
          onOpen={onOpen}
          activeSlug={activeSlug}
          editingSlug={editingSlug}
          onStartRename={setEditingSlug}
          onCommitRename={onCommitRename}
          onCancelRename={() => setEditingSlug(null)}
          onDelete={onDelete}
        />
      ))}
    </ul>
  )
}
