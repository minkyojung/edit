// One row of the note properties panel: an optional drag handle in the
// left gutter, a fixed-width `[icon] key` cell, and the value control,
// aligned to a common left edge across rows (the Notion property look).
//
// The key cell is a BUTTON: clicking it opens a compact solid menu
// (Rename / Delete — the FolderTree row-menu surface). Rename swaps the
// cell for an inline input (IME-guarded, Enter commits, Escape reverts,
// blur commits — the EditableTitleInput convention). Rows without
// `onRename`/`onDelete` fall back to a plain non-interactive cell.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { IconPencil, IconTrash } from '@tabler/icons-react'

type IconComponent = React.ComponentType<{
  size?: number | string
  stroke?: number | string
  className?: string
}>

// Same density recipe as FolderTree's ROW_MENU_SURFACE: keep the solid
// dropdown defaults, narrow the width, tighten the items.
const KEY_MENU_SURFACE = cn(
  'min-w-40',
  '[&_[data-slot=dropdown-menu-item]]:gap-2.5 [&_[data-slot=dropdown-menu-item]]:px-2 [&_[data-slot=dropdown-menu-item]]:py-1.5 [&_[data-slot=dropdown-menu-item]]:font-normal',
)

export function PropertyRow({
  icon: Icon,
  label,
  children,
  handle,
  onRename,
  onDelete,
}: {
  icon: IconComponent
  label: string
  children: ReactNode
  /** Drag-handle node rendered in the row's left gutter (visible on row
   * hover). The sortable wrapper owns its listeners. */
  handle?: ReactNode
  /** Commit a new key name. Absent → the key cell isn't renamable. */
  onRename?: (newKey: string) => void
  /** Remove this property row. Absent → no delete menu item. */
  onDelete?: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(label)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  function commit() {
    setRenaming(false)
    const next = draft.trim()
    if (next && next !== label) onRename?.(next)
    else setDraft(label)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Don't act on the Enter that finishes an IME composition (e.g.
    // confirming a Hangul syllable) — matches EditableTitleInput's guard.
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      inputRef.current?.blur()
    } else if (e.key === 'Escape') {
      setDraft(label)
      setRenaming(false)
    }
  }

  const interactive = Boolean(onRename || onDelete)

  return (
    <div className="group/prop relative -mx-1.5 flex min-h-8 items-center gap-2 rounded-md px-1.5 transition-colors hover:bg-accent/40">
      {handle}
      {renaming ? (
        <div className="flex w-36 shrink-0 items-center gap-1.5 text-footnote">
          <Icon size={15} stroke={1.75} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={onKeyDown}
            className="w-full min-w-0 rounded-sm bg-input/50 px-1 py-0.5 text-footnote text-foreground outline-none"
          />
        </div>
      ) : interactive ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-36 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm px-1 py-1 text-left text-footnote text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Icon size={15} stroke={1.75} className="shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="bottom"
            align="start"
            sideOffset={4}
            className={KEY_MENU_SURFACE}
          >
            {onRename ? (
              <DropdownMenuItem
                onSelect={() => {
                  setDraft(label)
                  setRenaming(true)
                }}
              >
                <IconPencil size={15} stroke={1.75} />
                Rename
              </DropdownMenuItem>
            ) : null}
            {onDelete ? (
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <IconTrash size={15} stroke={1.75} />
                Delete
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div className="flex w-36 shrink-0 items-center gap-1.5 px-1 text-footnote text-muted-foreground">
          <Icon size={15} stroke={1.75} className="shrink-0" />
          <span className="truncate">{label}</span>
        </div>
      )}
      <div className="min-w-0 flex-1 text-body text-foreground">{children}</div>
    </div>
  )
}
