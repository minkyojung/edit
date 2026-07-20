// Notion-style properties panel — the metadata block between a note's
// title and its body. Every frontmatter key renders as a row (order =
// file key order via panelRows/effectiveEntries); rows drag-reorder with
// the ⋮⋮ handle (persisted as the file's key order), the key cell opens
// a Rename/Delete menu, values edit inline, and "+ Add a property"
// appends a custom key. Typed keys keep their dedicated controls
// (status badge, tag chips, read switch); custom values pick their
// editor by shape — list → chips, true/false → switch, else text.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  IconAlignLeft,
  IconCalendar,
  IconCircleDashed,
  IconClock,
  IconList,
  IconPlus,
  IconTag,
  IconToggleLeft,
  IconWorld,
} from '@tabler/icons-react'
import type { KnownDoc } from '@/state/docsStore'
import { useDocsStore } from '@/state/docsStore'
import { Switch } from '@/components/ui/switch'
import { PropertyRow } from './PropertyRow'
import { StatusControl } from './StatusControl'
import { TagInput } from './TagInput'
import { panelRows, type PanelRow } from './propertyRows'

const KEY_ICONS: Record<string, typeof IconAlignLeft> = {
  status: IconCircleDashed,
  tags: IconTag,
  created: IconCalendar,
  source: IconWorld,
  readAt: IconClock,
  savedAt: IconClock,
  durationSec: IconClock,
}

function iconFor(row: PanelRow) {
  const byKey = KEY_ICONS[row.key]
  if (byKey) return byKey
  if (row.editor === 'list') return IconList
  if (row.editor === 'switch') return IconToggleLeft
  return IconAlignLeft
}

/** Borderless inline text value — the TagInput/EditableTitleInput
 * conventions: draft state, blur/Enter commit (IME-guarded), Escape
 * reverts. Re-syncs from props unless focused (don't clobber typing). */
function TextValue({
  value,
  onCommit,
}: {
  value: string
  onCommit: (next: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(value)
  }, [value])

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // IME guard — don't commit the Enter that finishes a Hangul syllable.
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      inputRef.current?.blur()
    } else if (e.key === 'Escape') {
      setDraft(value)
      requestAnimationFrame(() => inputRef.current?.blur())
    }
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft)
      }}
      onKeyDown={onKeyDown}
      placeholder="Empty"
      className="w-full min-w-0 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground/60"
    />
  )
}

/** Trailing "+ Add a property" affordance: a quiet button that swaps to
 * an inline key input; Enter (IME-guarded) creates the property with an
 * empty value, ready for its value editor. */
function AddPropertyRow({ onAdd }: { onAdd: (key: string) => boolean }) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (adding) inputRef.current?.focus()
  }, [adding])

  function commit() {
    const key = draft.trim()
    setDraft('')
    setAdding(false)
    if (key) onAdd(key)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      setDraft('')
      setAdding(false)
    }
  }

  if (adding) {
    return (
      <div className="-mx-1.5 flex min-h-9 items-center gap-2 rounded-md px-1.5">
        <div className="flex w-40 shrink-0 items-center gap-2 text-body">
          <IconAlignLeft size={17} stroke={2.25} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={onKeyDown}
            placeholder="Property name"
            className="w-full min-w-0 rounded-sm bg-input/50 px-1 py-0.5 text-body text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => setAdding(true)}
      className="-mx-1.5 flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-1.5 text-body font-medium text-muted-foreground/70 transition-colors hover:bg-accent/40 hover:text-muted-foreground"
    >
      <IconPlus size={17} stroke={2.25} />
      Add a property
    </button>
  )
}

function RowValue({ slug, known, row }: { slug: string; known: KnownDoc; row: PanelRow }) {
  const setArticleRead = useDocsStore((s) => s.setArticleRead)
  const setDocTags = useDocsStore((s) => s.setDocTags)
  const setDocProperty = useDocsStore((s) => s.setDocProperty)

  switch (row.editor) {
    case 'status':
      return <StatusControl slug={slug} status={known.status} />
    case 'tags':
      return (
        <TagInput tags={known.tags ?? []} onChange={(next) => setDocTags(slug, next)} />
      )
    case 'source':
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          {known.faviconUrl ? (
            <img src={known.faviconUrl} alt="" className="size-3.5 shrink-0 rounded-sm" />
          ) : null}
          <span className="truncate">{known.sourceUrl}</span>
        </span>
      )
    case 'switch':
      if (row.key === 'readAt') {
        return (
          <Switch
            checked={!!known.readAt}
            onCheckedChange={(v) => setArticleRead(slug, v)}
            aria-label="readAt"
          />
        )
      }
      return (
        <Switch
          checked={row.value === 'true'}
          onCheckedChange={(v) => setDocProperty(slug, row.key, v ? 'true' : 'false')}
          aria-label={row.key}
        />
      )
    case 'list':
      return (
        <TagInput
          tags={Array.isArray(row.value) ? row.value : []}
          onChange={(next) => setDocProperty(slug, row.key, next)}
        />
      )
    case 'text':
      return (
        <TextValue
          value={typeof row.value === 'string' ? row.value : ''}
          onCommit={(next) => setDocProperty(slug, row.key, next)}
        />
      )
  }
}

function SortableRow({ slug, known, row }: { slug: string; known: KnownDoc; row: PanelRow }) {
  const renameDocProperty = useDocsStore((s) => s.renameDocProperty)
  const deleteDocProperty = useDocsStore((s) => s.deleteDocProperty)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.key })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'relative z-10 opacity-70' : undefined}
    >
      <PropertyRow
        icon={iconFor(row)}
        label={row.key}
        dragProps={{ ...attributes, ...listeners }}
        onRename={(newKey) => renameDocProperty(slug, row.key, newKey)}
        onDelete={() => deleteDocProperty(slug, row.key)}
      >
        <RowValue slug={slug} known={known} row={row} />
      </PropertyRow>
    </div>
  )
}

export function PropertiesPanel({ slug, known }: { slug: string; known: KnownDoc }) {
  const reorderDocProperties = useDocsStore((s) => s.reorderDocProperties)
  const addDocProperty = useDocsStore((s) => s.addDocProperty)
  const rows = panelRows(known)

  // 5px activation distance so plain clicks (key menu, value editors)
  // aren't swallowed by the drag sensor — the FolderTree convention.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const keys = rows.map((r) => r.key)
    const from = keys.indexOf(String(active.id))
    const to = keys.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    reorderDocProperties(slug, arrayMove(keys, from, to))
  }

  return (
    <div className="mb-6 flex flex-col gap-0.5">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={rows.map((r) => r.key)} strategy={verticalListSortingStrategy}>
          {rows.map((row) => (
            <SortableRow key={row.key} slug={slug} known={known} row={row} />
          ))}
        </SortableContext>
      </DndContext>
      <AddPropertyRow onAdd={(key) => addDocProperty(slug, key, '')} />
    </div>
  )
}
