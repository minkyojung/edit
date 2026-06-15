// FolderTree — Obsidian-style sidebar tree built from the catalog.
//
// Folders expand/collapse; clicking a file opens it via the slug URL.
// Files rename inline (double-click the name or right-click → Rename),
// delete via right-click, and drag onto a folder row to move there.
// New folders are created inline via the header button (newFolderStore).
//
// Drag: dnd-kit. File rows are draggable; folder ROWS are drop targets
// (the droppable wraps just the row, not its children, so nested folders
// don't overlap). `pointerWithin` means a drop only moves when released
// over an actual folder row — dropping on a file or empty space is a
// no-op. A 5px activation distance keeps plain clicks / double-clicks
// working. Fold state is local + by folder path.

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { IconChevronRight, IconFolder } from '@tabler/icons-react'
import { useDocsStore } from '@/state/docsStore'
import { useNewFolderStore } from '@/state/newFolderStore'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import {
  buildFileTree,
  type TreeFile,
  type TreeFolder,
  type TreeNode,
} from '@/lib/fileTree'
import { open as openInDefaultApp } from '@tauri-apps/plugin-shell'
import { invoke } from '@tauri-apps/api/core'
import { buildViewUrl } from '@/lib/viewUrl'
import { vaultAbsPath } from '@/lib/vault'
import { pathForDoc, sanitizeFilename } from '@/lib/docPaths'
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

/** Shared per-render handlers + view state, passed down the recursion so
 * each node doesn't need a dozen individual props. */
interface TreeCtx {
  expanded: Set<string>
  onToggle: (path: string) => void
  onOpen: (slug: string) => void
  activeSlug: string | null
  editingSlug: string | null
  onStartRename: (slug: string) => void
  onCommitRename: (slug: string, name: string) => void
  onCancelRename: () => void
  onDelete: (slug: string) => void
  onMoveToRoot: (slug: string) => void
  onDuplicate: (slug: string) => void
  onCopyPath: (relPath: string) => void
  onOpenInDefaultApp: (relPath: string) => void
  onRevealInFinder: (relPath: string) => void
  editingFolderPath: string | null
  onStartFolderRename: (path: string) => void
  onCommitFolderRename: (path: string, name: string) => void
  onCancelFolderRename: () => void
  onDeleteFolder: (path: string) => void
}

function FileNode({ node, ctx }: { node: TreeFile; ctx: TreeCtx }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: node.slug,
  })
  const isEditing = ctx.editingSlug === node.slug
  const isActive = node.slug === ctx.activeSlug
  // Scroll the active note into view when it becomes active (e.g. opened
  // from search, or revealed by auto-expanding its folders).
  const rowRef = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    if (isActive) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [isActive])
  return (
    <li
      ref={(el) => {
        setNodeRef(el)
        rowRef.current = el
      }}
      {...attributes}
      {...listeners}
      className={isDragging ? 'opacity-50' : undefined}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <TreeRow active={isActive}>
            {/* Empty lead keeps file text aligned under folder labels;
                files are text-only (no icon) per the Obsidian look. */}
            <TreeRowLead asChild>
              <span aria-hidden />
            </TreeRowLead>
            {isEditing ? (
              <RenameInput
                initial={node.name}
                onCommit={(name) => ctx.onCommitRename(node.slug, name)}
                onCancel={ctx.onCancelRename}
              />
            ) : (
              <TreeRowLabel
                onClick={() => ctx.onOpen(node.slug)}
                onDoubleClick={() => ctx.onStartRename(node.slug)}
              >
                <span className="truncate">{node.name}</span>
              </TreeRowLabel>
            )}
          </TreeRow>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => ctx.onStartRename(node.slug)}>
            Rename
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => ctx.onDuplicate(node.slug)}>
            Duplicate
          </ContextMenuItem>
          {node.path.includes('/') && (
            <ContextMenuItem onSelect={() => ctx.onMoveToRoot(node.slug)}>
              Move to root
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => ctx.onCopyPath(node.path)}>
            Copy path
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => ctx.onOpenInDefaultApp(node.path)}>
            Open in default app
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => ctx.onRevealInFinder(node.path)}>
            Reveal in Finder
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => ctx.onDelete(node.slug)}
            className="text-destructive focus:text-destructive"
          >
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
}

function FolderNode({ node, ctx }: { node: TreeFolder; ctx: TreeCtx }) {
  const isOpen = ctx.expanded.has(node.path)
  const isEditing = ctx.editingFolderPath === node.path
  // Droppable wraps ONLY the row (not the children) so nested folder
  // drop zones don't overlap. `folder:` prefix distinguishes the id.
  const { setNodeRef, isOver } = useDroppable({ id: `folder:${node.path}` })
  return (
    <Collapsible asChild open={isOpen} onOpenChange={() => ctx.onToggle(node.path)}>
      <li>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div ref={setNodeRef}>
              <TreeRow
                className={
                  isOver
                    ? 'bg-sidebar-accent ring-1 ring-inset ring-sidebar-ring/50'
                    : undefined
                }
              >
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
                {isEditing ? (
                  <RenameInput
                    initial={node.name}
                    onCommit={(name) => ctx.onCommitFolderRename(node.path, name)}
                    onCancel={ctx.onCancelFolderRename}
                  />
                ) : (
                  <TreeRowLabel
                    onClick={() => ctx.onToggle(node.path)}
                    onDoubleClick={() => ctx.onStartFolderRename(node.path)}
                  >
                    <span className="truncate">{node.name}</span>
                  </TreeRowLabel>
                )}
              </TreeRow>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => ctx.onStartFolderRename(node.path)}>
              Rename
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => ctx.onDeleteFolder(node.path)}
              className="text-destructive focus:text-destructive"
            >
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <CollapsibleContent asChild>
          <TreeSub>
            {node.children.map((child) => (
              <NodeView key={child.path} node={child} ctx={ctx} />
            ))}
          </TreeSub>
        </CollapsibleContent>
      </li>
    </Collapsible>
  )
}

function NodeView({ node, ctx }: { node: TreeNode; ctx: TreeCtx }) {
  return node.kind === 'file' ? (
    <FileNode node={node} ctx={ctx} />
  ) : (
    <FolderNode node={node} ctx={ctx} />
  )
}

/** Drop target for the empty area below the tree = the vault root.
 * Separate region from folder rows, so `pointerWithin` never confuses
 * the two. Lets a note be dragged back out of a folder (Finder-style).
 * id `folder:` → empty folder path → root in onDragEnd. */
function RootDropZone() {
  const { setNodeRef, isOver } = useDroppable({ id: 'folder:' })
  return (
    <div
      ref={setNodeRef}
      className={
        'mx-2 mt-1 min-h-16 flex-1 rounded-lg ' +
        (isOver ? 'bg-sidebar-accent ring-1 ring-inset ring-sidebar-ring/50' : '')
      }
    />
  )
}

export function FolderTree() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const knownFolders = useDocsStore((s) => s.knownFolders)
  const sidebarTab = useDocsStore((s) => s.sidebarTab)
  const dayAnchor = useDocsStore((s) => s.dayAnchor)
  const monthAnchor = useDocsStore((s) => s.monthAnchor)
  const renameDoc = useDocsStore((s) => s.renameDoc)
  const deleteToTrash = useDocsStore((s) => s.deleteToTrash)
  const createFolder = useDocsStore((s) => s.createFolder)
  const moveDocToFolder = useDocsStore((s) => s.moveDocToFolder)
  const renameFolder = useDocsStore((s) => s.renameFolder)
  const deleteFolder = useDocsStore((s) => s.deleteFolder)
  const duplicateDoc = useDocsStore((s) => s.duplicateDoc)
  const creatingFolder = useNewFolderStore((s) => s.creating)
  const stopNewFolder = useNewFolderStore((s) => s.stop)
  const navigate = useNavigate()
  const activeSlug = useActiveSlug()

  const tree = useMemo(
    () => buildFileTree(knownDocs, knownFolders),
    [knownDocs, knownFolders],
  )
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [editingSlug, setEditingSlug] = useState<string | null>(null)
  const [editingFolderPath, setEditingFolderPath] = useState<string | null>(null)

  // Reveal the active note: when it changes, expand all of its ancestor
  // folders so it's always visible (and FileNode scrolls it into view).
  // Reads knownDocs via getState so this only fires on activeSlug change,
  // not on every edit — leaving manual collapses alone between navigations.
  useEffect(() => {
    if (!activeSlug) return
    const docs = useDocsStore.getState().knownDocs
    const doc = docs.find((d) => d.slug === activeSlug)
    if (!doc) return
    const bySlug = new Map(docs.map((d) => [d.slug, d]))
    const p = pathForDoc(doc, (s) => bySlug.get(s))
    if (!p) return
    const segs = p.split('/')
    segs.pop() // drop the filename
    if (segs.length === 0) return
    setExpanded((prev) => {
      const next = new Set(prev)
      let acc = ''
      let changed = false
      for (const seg of segs) {
        acc = acc ? `${acc}/${seg}` : seg
        if (!next.has(acc)) {
          next.add(acc)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [activeSlug])
  // Slug currently being dragged — drives the DragOverlay chip that
  // follows the cursor so the drag is visible before the drop.
  const [draggingSlug, setDraggingSlug] = useState<string | null>(null)
  const draggingDoc = draggingSlug
    ? knownDocs.find((d) => d.slug === draggingSlug)
    : null

  // 5px activation distance so a plain click (open) / double-click
  // (rename) isn't swallowed by the drag sensor.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

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
  const onCreateFolder = (name: string) => {
    const trimmed = name.trim()
    stopNewFolder()
    if (trimmed) void createFolder(sanitizeFilename(trimmed))
  }
  const onCommitFolderRename = (path: string, name: string) => {
    setEditingFolderPath(null)
    if (name.trim()) void renameFolder(path, name)
  }
  const onDeleteFolder = (path: string) => {
    void deleteFolder(path).then((next) => {
      if (next) navigate(buildViewUrl({ tab: sidebarTab, dayAnchor, monthAnchor, slug: next }))
    })
  }
  const onMoveToRoot = (slug: string) => moveDocToFolder(slug, '')
  const onDuplicate = (slug: string) => {
    void duplicateDoc(slug).then((next) => {
      if (next) navigate(buildViewUrl({ tab: sidebarTab, dayAnchor, monthAnchor, slug: next }))
    })
  }
  const onCopyPath = (relPath: string) => {
    void vaultAbsPath(relPath).then((abs) =>
      navigator.clipboard.writeText(abs).catch((err) =>
        console.warn('[docs] copy path failed', err),
      ),
    )
  }
  const onOpenInDefaultApp = (relPath: string) => {
    void vaultAbsPath(relPath).then((abs) =>
      openInDefaultApp(abs).catch((err) =>
        console.warn('[docs] open in default app failed', err),
      ),
    )
  }
  const onRevealInFinder = (relPath: string) => {
    void vaultAbsPath(relPath).then((abs) =>
      invoke('reveal_in_finder', { path: abs }).catch((err) =>
        console.warn('[docs] reveal in finder failed', err),
      ),
    )
  }
  const onDragStart = (e: DragStartEvent) => setDraggingSlug(String(e.active.id))
  const onDragEnd = (e: DragEndEvent) => {
    setDraggingSlug(null)
    const overId = e.over ? String(e.over.id) : null
    if (!overId || !overId.startsWith('folder:')) return
    moveDocToFolder(String(e.active.id), overId.slice('folder:'.length))
  }

  const ctx: TreeCtx = {
    expanded,
    onToggle,
    onOpen,
    activeSlug,
    editingSlug,
    onStartRename: setEditingSlug,
    onCommitRename,
    onCancelRename: () => setEditingSlug(null),
    onDelete,
    onMoveToRoot,
    onDuplicate,
    onCopyPath,
    onOpenInDefaultApp,
    onRevealInFinder,
    editingFolderPath,
    onStartFolderRename: setEditingFolderPath,
    onCommitFolderRename,
    onCancelFolderRename: () => setEditingFolderPath(null),
    onDeleteFolder,
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDraggingSlug(null)}
    >
      <div className="flex h-full flex-col">
        <ul className="flex flex-col px-2 py-1">
          {creatingFolder && (
            <li>
              <TreeRow>
                <TreeRowLead asChild>
                  <span aria-hidden>
                    <IconFolder size={16} className="text-muted-foreground" />
                  </span>
                </TreeRowLead>
                <RenameInput
                  initial=""
                  onCommit={onCreateFolder}
                  onCancel={stopNewFolder}
                />
              </TreeRow>
            </li>
          )}
          {tree.map((node) => (
            <NodeView key={node.path} node={node} ctx={ctx} />
          ))}
        </ul>
        {/* Empty area below the tree = drag-to-root target. */}
        <RootDropZone />
      </div>
      {/* Chip that follows the cursor while dragging, so the drag is
          visible before the drop lands. */}
      <DragOverlay dropAnimation={null}>
        {draggingDoc ? (
          <div className="rounded-xl bg-sidebar px-3 py-1 text-sm font-medium text-sidebar-foreground shadow-lg ring-1 ring-sidebar-border">
            <span className="truncate">
              {draggingDoc.title?.trim() ||
                draggingDoc.relPath?.split('/').pop()?.replace(/\.md$/, '') ||
                'Untitled'}
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
