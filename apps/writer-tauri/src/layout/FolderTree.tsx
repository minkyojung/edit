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

import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
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
import {
  IconChevronRight,
  IconFolder,
  IconPhoto,
  IconFileTypePdf,
  IconMusic,
  IconVideo,
  IconFileText,
  IconFile,
} from '@tabler/icons-react'
import { useDocsStore } from '@/state/docsStore'
import { useNewFolderStore } from '@/state/newFolderStore'
import { useSortStore } from '@/state/sortStore'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import {
  buildFileTree,
  isHiddenTreePath,
  type TreeAttachment,
  type TreeFile,
  type TreeFolder,
  type TreeNode,
} from '@/lib/fileTree'
import { classifyAsset } from '@/lib/attachments'
import { buildViewUrl } from '@/lib/viewUrl'
import { openVaultFile, revealVaultFile, vaultAbsPath } from '@/lib/vault'
import { pathForDoc, sanitizeFilename } from '@/lib/docPaths'
import { planFolderMove } from '@/lib/folderMove'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

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
      className="mx-2 h-7 min-w-0 flex-1 rounded-sm border border-sidebar-border bg-sidebar px-1 text-body text-sidebar-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-sidebar-ring/40"
    />
  )
}

/** Right-click menu anchored to the ROW (not the cursor).
 *
 * Radix ContextMenu hard-anchors a 0×0 virtual rect at the pointer and
 * omits side/align, so its menu always overlaps the clicked row. To get
 * "open to the right of the row, top-aligned, no overlap" we drive a
 * DropdownMenu instead: an invisible, click-through trigger overlays the
 * row (so it becomes the popper anchor) and right-click opens the menu
 * with side="right" align="start". Left-click still falls through to the
 * row (open note / toggle folder). */
// Folder menu surface — brighter panel that matches the sidebar's selected
// row color (color-mix foreground 18% + sidebar), frosted via backdrop-blur,
// wider with a smaller radius. Applied to both the content and the "Move to…"
// sub-content so the whole menu reads as one bright surface. (Overrides the
// dropdown-menu defaults bg-popover / min-w-48 / rounded-md via tailwind-merge.)
const ROW_MENU_SURFACE =
  'min-w-64 rounded-lg border border-foreground/8 bg-[color-mix(in_oklch,var(--foreground)_18%,var(--sidebar))]/55 backdrop-blur-2xl'

function RowContextMenu({
  children,
  items,
}: {
  children: ReactNode
  items: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className="relative"
      onContextMenu={(e) => {
        e.preventDefault()
        setOpen(true)
      }}
    >
      {children}
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none absolute inset-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="right"
          align="start"
          sideOffset={6}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className={ROW_MENU_SURFACE}
        >
          {items}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
  /** Destination folders for "Move to…" (vault-relative, non-hidden). */
  folders: string[]
  onMoveTo: (slug: string, folderPath: string) => void
  onDuplicate: (slug: string) => void
  onCopyPath: (relPath: string) => void
  onOpenInDefaultApp: (relPath: string) => void
  onRevealInFinder: (relPath: string) => void
  /** Open a non-md attachment in the in-app file viewer (by path). */
  onOpenFile: (relPath: string) => void
  editingFolderPath: string | null
  onStartFolderRename: (path: string) => void
  onCommitFolderRename: (path: string, name: string) => void
  onCancelFolderRename: () => void
  onDeleteFolder: (path: string) => void
  /** Folder path under which a new subfolder is being named (null = none). */
  creatingSubfolderParent: string | null
  onStartCreateSubfolder: (parentPath: string) => void
  onCommitCreateSubfolder: (parentPath: string, name: string) => void
  onCancelCreateSubfolder: () => void
  /** Path of the folder currently being dragged (null = none / dragging a
   * doc). Lets each folder row grey out drop targets it can't land in. */
  draggingFolderPath: string | null
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
    // Skip the profile note — it's opened from the top nav, so scrolling the
    // tree to reveal wiki/profile would be a jarring, unwanted jump.
    if (isActive && node.type !== 'wiki:profile') {
      rowRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [isActive, node.type])
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
      <RowContextMenu
        items={
          <>
            <DropdownMenuItem onSelect={() => ctx.onStartRename(node.slug)}>
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => ctx.onDuplicate(node.slug)}>
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Move to…</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={ROW_MENU_SURFACE}>
                <DropdownMenuItem onSelect={() => ctx.onMoveTo(node.slug, '')}>
                  (vault root)
                </DropdownMenuItem>
                {ctx.folders.length > 0 && <DropdownMenuSeparator />}
                {ctx.folders.map((f) => (
                  <DropdownMenuItem key={f} onSelect={() => ctx.onMoveTo(node.slug, f)}>
                    {f}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => ctx.onCopyPath(node.path)}>
              Copy path
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => ctx.onOpenInDefaultApp(node.path)}>
              Open in default app
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => ctx.onRevealInFinder(node.path)}>
              Reveal in Finder
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => ctx.onDelete(node.slug)}
              className="text-destructive focus:text-destructive"
            >
              Delete
            </DropdownMenuItem>
          </>
        }
      >
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
      </RowContextMenu>
    </li>
  )
}

function FolderNode({ node, ctx }: { node: TreeFolder; ctx: TreeCtx }) {
  const isOpen = ctx.expanded.has(node.path)
  const isEditing = ctx.editingFolderPath === node.path
  // Droppable wraps ONLY the row (not the children) so nested folder
  // drop zones don't overlap. `folder:` prefix distinguishes the id from
  // a doc-slug drag. The row is BOTH draggable (move this folder) and
  // droppable (move something into it) — dnd-kit keeps those registries
  // separate, so the shared id is fine; refs are composed below.
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `folder:${node.path}`,
  })
  const {
    setNodeRef: setDragRef,
    attributes,
    listeners,
    isDragging,
  } = useDraggable({ id: `folder:${node.path}` })
  const setRowRef = (el: HTMLElement | null) => {
    setDropRef(el)
    setDragRef(el)
  }
  // Don't highlight a drop target the dragged folder can't land in (its
  // own subtree) — same reject rule the move action enforces.
  const dropInvalid =
    ctx.draggingFolderPath != null &&
    planFolderMove(ctx.draggingFolderPath, node.path).kind === 'reject'
  const showDrop = isOver && !dropInvalid
  return (
    <Collapsible asChild open={isOpen} onOpenChange={() => ctx.onToggle(node.path)}>
      <li className={isDragging ? 'opacity-50' : undefined}>
        <RowContextMenu
          items={
            <>
              <DropdownMenuItem onSelect={() => ctx.onStartCreateSubfolder(node.path)}>
                New subfolder
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => ctx.onStartFolderRename(node.path)}>
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => ctx.onDeleteFolder(node.path)}
                className="text-destructive focus:text-destructive"
              >
                Delete
              </DropdownMenuItem>
            </>
          }
        >
          <div ref={setRowRef} {...attributes} {...listeners}>
            <TreeRow
              className={
                showDrop
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
        </RowContextMenu>
        <CollapsibleContent asChild>
          <TreeSub>
            {ctx.creatingSubfolderParent === node.path && (
              <li>
                <TreeRow>
                  <TreeRowLead asChild>
                    <span aria-hidden>
                      <IconFolder size={16} className="text-muted-foreground" />
                    </span>
                  </TreeRowLead>
                  <RenameInput
                    initial=""
                    onCommit={(name) => ctx.onCommitCreateSubfolder(node.path, name)}
                    onCancel={ctx.onCancelCreateSubfolder}
                  />
                </TreeRow>
              </li>
            )}
            {node.children.map((child) => (
              <NodeView key={child.path} node={child} ctx={ctx} />
            ))}
          </TreeSub>
        </CollapsibleContent>
      </li>
    </Collapsible>
  )
}

/** Icon for an attachment row, picked from its extension class. */
function attachmentIcon(name: string) {
  switch (classifyAsset(name)) {
    case 'image':
      return IconPhoto
    case 'pdf':
      return IconFileTypePdf
    case 'audio':
      return IconMusic
    case 'video':
      return IconVideo
    case 'text':
      return IconFileText
    default:
      return IconFile
  }
}

/** A non-markdown file row. Read-only: clicking opens the in-app viewer;
 * the context menu only exposes the path-based actions (no rename / delete
 * / move — attachments aren't catalog docs). */
function AttachmentNode({ node, ctx }: { node: TreeAttachment; ctx: TreeCtx }) {
  const Icon = attachmentIcon(node.name)
  return (
    <li>
      <RowContextMenu
        items={
          <>
            <DropdownMenuItem onSelect={() => ctx.onCopyPath(node.path)}>
              Copy path
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => ctx.onOpenInDefaultApp(node.path)}>
              Open in default app
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => ctx.onRevealInFinder(node.path)}>
              Reveal in Finder
            </DropdownMenuItem>
          </>
        }
      >
        <TreeRow>
          <TreeRowLead asChild>
            <span aria-hidden>
              <Icon size={16} className="text-muted-foreground" />
            </span>
          </TreeRowLead>
          <TreeRowLabel onClick={() => ctx.onOpenFile(node.path)}>
            <span className="truncate">{node.name}</span>
          </TreeRowLabel>
        </TreeRow>
      </RowContextMenu>
    </li>
  )
}

function NodeView({ node, ctx }: { node: TreeNode; ctx: TreeCtx }) {
  if (node.kind === 'file') return <FileNode node={node} ctx={ctx} />
  if (node.kind === 'attachment') return <AttachmentNode node={node} ctx={ctx} />
  return <FolderNode node={node} ctx={ctx} />
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
        'ml-3 mr-2 mt-1 min-h-16 flex-1 rounded-lg ' +
        (isOver ? 'bg-sidebar-accent ring-1 ring-inset ring-sidebar-ring/50' : '')
      }
    />
  )
}

export function FolderTree() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const knownFolders = useDocsStore((s) => s.knownFolders)
  const knownFiles = useDocsStore((s) => s.knownFiles)
  const sidebarTab = useDocsStore((s) => s.sidebarTab)
  const dayAnchor = useDocsStore((s) => s.dayAnchor)
  const monthAnchor = useDocsStore((s) => s.monthAnchor)
  const renameDoc = useDocsStore((s) => s.renameDoc)
  const deleteToTrash = useDocsStore((s) => s.deleteToTrash)
  const createFolder = useDocsStore((s) => s.createFolder)
  const moveDocToFolder = useDocsStore((s) => s.moveDocToFolder)
  const renameFolder = useDocsStore((s) => s.renameFolder)
  const moveFolder = useDocsStore((s) => s.moveFolder)
  const deleteFolder = useDocsStore((s) => s.deleteFolder)
  const duplicateDoc = useDocsStore((s) => s.duplicateDoc)
  const creatingFolder = useNewFolderStore((s) => s.creating)
  const stopNewFolder = useNewFolderStore((s) => s.stop)
  const sortMode = useSortStore((s) => s.mode)
  const navigate = useNavigate()
  const activeSlug = useActiveSlug()

  const tree = useMemo(
    () => buildFileTree(knownDocs, knownFolders, sortMode, knownFiles),
    [knownDocs, knownFolders, sortMode, knownFiles],
  )
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [editingSlug, setEditingSlug] = useState<string | null>(null)
  const [editingFolderPath, setEditingFolderPath] = useState<string | null>(null)
  const [creatingSubfolderParent, setCreatingSubfolderParent] = useState<
    string | null
  >(null)

  // Reveal the active note: when it changes, expand all of its ancestor
  // folders so it's always visible (and FileNode scrolls it into view).
  // Reads knownDocs via getState so this only fires on activeSlug change,
  // not on every edit — leaving manual collapses alone between navigations.
  useEffect(() => {
    if (!activeSlug) return
    const docs = useDocsStore.getState().knownDocs
    const doc = docs.find((d) => d.slug === activeSlug)
    if (!doc) return
    // The profile note has its own top-nav entry; opening it from there
    // shouldn't auto-expand wiki/ and yank the tree down to reveal it.
    if (doc.type === 'wiki:profile') return
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
  // What's currently being dragged — drives the DragOverlay chip that
  // follows the cursor. Exactly one of these is set at a time: a doc
  // (bare slug id) or a folder (`folder:<path>` id).
  const [draggingSlug, setDraggingSlug] = useState<string | null>(null)
  const [draggingFolderPath, setDraggingFolderPath] = useState<string | null>(
    null,
  )
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
  // Attachments open the in-app file viewer, keyed by path (encode so a
  // nested path's slashes survive as one route param).
  const onOpenFile = (relPath: string) =>
    navigate(`/file/${encodeURIComponent(relPath)}`)
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
  const onStartCreateSubfolder = (parentPath: string) => {
    setCreatingSubfolderParent(parentPath)
    // Expand the parent so its (newly mounted) name input is visible.
    setExpanded((prev) => (prev.has(parentPath) ? prev : new Set(prev).add(parentPath)))
  }
  const onCommitCreateSubfolder = (parentPath: string, name: string) => {
    setCreatingSubfolderParent(null)
    const trimmed = name.trim()
    if (trimmed) void createFolder(`${parentPath}/${sanitizeFilename(trimmed)}`)
  }
  const onCancelCreateSubfolder = () => setCreatingSubfolderParent(null)
  const moveTargets = useMemo(
    () =>
      knownFolders
        .filter((f) => !isHiddenTreePath(f))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    [knownFolders],
  )
  const onMoveTo = (slug: string, folderPath: string) =>
    moveDocToFolder(slug, folderPath)
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
    void openVaultFile(relPath).catch((err) =>
      console.warn('[docs] open in default app failed', err),
    )
  }
  const onRevealInFinder = (relPath: string) => {
    void revealVaultFile(relPath).catch((err) =>
      console.warn('[docs] reveal in finder failed', err),
    )
  }
  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id)
    if (id.startsWith('folder:')) {
      setDraggingFolderPath(id.slice('folder:'.length))
      setDraggingSlug(null)
    } else {
      setDraggingSlug(id)
      setDraggingFolderPath(null)
    }
  }
  const resetDrag = () => {
    setDraggingSlug(null)
    setDraggingFolderPath(null)
  }
  const onDragEnd = (e: DragEndEvent) => {
    resetDrag()
    const activeId = String(e.active.id)
    const overId = e.over ? String(e.over.id) : null
    if (!overId || !overId.startsWith('folder:')) return
    const dest = overId.slice('folder:'.length)
    if (activeId.startsWith('folder:')) {
      void moveFolder(activeId.slice('folder:'.length), dest)
    } else {
      moveDocToFolder(activeId, dest)
    }
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
    folders: moveTargets,
    onMoveTo,
    onDuplicate,
    onCopyPath,
    onOpenInDefaultApp,
    onRevealInFinder,
    onOpenFile,
    editingFolderPath,
    onStartFolderRename: setEditingFolderPath,
    onCommitFolderRename,
    onCancelFolderRename: () => setEditingFolderPath(null),
    onDeleteFolder,
    creatingSubfolderParent,
    onStartCreateSubfolder,
    onCommitCreateSubfolder,
    onCancelCreateSubfolder,
    draggingFolderPath,
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={resetDrag}
    >
      <div className="flex h-full flex-col">
        {/* Left gutter (pl-3 = 12px) so row ICON/TEXT lands on the traffic-light
            leading edge (12px gutter + the lead's 8px ml = 20px); the fill may
            spill a touch left, which is intentional. In sync with the Sidebar
            surface-list nav. */}
        <ul className="flex flex-col py-1 pl-3 pr-2">
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
        {draggingFolderPath ? (
          <div className="flex items-center gap-1.5 rounded-xl bg-sidebar px-3 py-1 text-body font-medium text-sidebar-foreground shadow-lg ring-1 ring-sidebar-border">
            <IconFolder size={16} className="text-muted-foreground" />
            <span className="truncate">
              {draggingFolderPath.split('/').pop()}
            </span>
          </div>
        ) : draggingDoc ? (
          <div className="rounded-xl bg-sidebar px-3 py-1 text-body font-medium text-sidebar-foreground shadow-lg ring-1 ring-sidebar-border">
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
