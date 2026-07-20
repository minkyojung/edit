// One row of the note properties panel: a fixed-width `[icon] key` cell
// aligned with the title's left edge, and the value control beside it
// (the Notion property look).
//
// The icon slot doubles as the drag handle (Notion's trick — no extra
// gutter, so the row stays left-aligned with the title): the property
// icon shows at rest and swaps to a ⋮⋮ grip on row hover, in the same
// 15px box. The KEY LABEL is the menu trigger — clicking it opens a
// compact solid Rename/Delete menu; Rename swaps the label for an inline
// input (IME-guarded, Enter commits, Escape reverts, blur commits — the
// EditableTitleInput convention).

import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { IconGripVertical, IconPencil, IconTrash } from '@tabler/icons-react'

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
  dragProps,
  onRename,
  onDelete,
}: {
  icon: IconComponent
  label: string
  children: ReactNode
  /** dnd-kit sortable listeners + attributes, spread onto the icon slot
   * so the icon area IS the drag handle. Absent → the row isn't
   * draggable and the icon just renders. */
  dragProps?: ComponentProps<'button'>
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

  // The icon slot: property icon at rest, ⋮⋮ grip on row hover, both in
  // the same 15px box so nothing shifts. When draggable it's the handle.
  const iconSlot = (
    <button
      type="button"
      {...dragProps}
      aria-label={dragProps ? `Reorder ${label}` : undefined}
      className={cn(
        'relative flex size-[15px] shrink-0 items-center justify-center text-muted-foreground',
        dragProps && 'cursor-grab active:cursor-grabbing',
      )}
    >
      <Icon
        size={15}
        stroke={1.75}
        className={cn('shrink-0', dragProps && 'transition-opacity group-hover/prop:opacity-0')}
      />
      {dragProps ? (
        <IconGripVertical
          size={15}
          stroke={1.75}
          className="absolute opacity-0 transition-opacity group-hover/prop:opacity-100"
        />
      ) : null}
    </button>
  )

  return (
    <div className="group/prop -mx-1.5 flex min-h-8 items-center gap-2 rounded-md px-1.5 transition-colors hover:bg-accent/40">
      <div className="flex w-36 shrink-0 items-center gap-1.5 text-footnote text-muted-foreground">
        {iconSlot}
        {renaming ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={onKeyDown}
            className="w-full min-w-0 rounded-sm bg-input/50 px-1 py-0.5 text-footnote text-foreground outline-none"
          />
        ) : onRename || onDelete ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="min-w-0 flex-1 cursor-pointer truncate rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-accent hover:text-foreground"
              >
                {label}
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
          <span className="truncate px-1">{label}</span>
        )}
      </div>
      <div className="min-w-0 flex-1 text-body text-foreground">{children}</div>
    </div>
  )
}
