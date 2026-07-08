import {
  IconChecklist,
  IconCircle,
  IconCircleCheck,
  IconCircleDot,
} from '@tabler/icons-react'
import type { ToolPart } from '@/chat/types'
import { ActivityRow } from '@/chat/parts/ActivityRow'
import { cn } from '@/lib/utils'

interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Present-continuous form shown while in progress ("Reading the file"). */
  activeForm?: string
}

/** Renders a TodoWrite call as the model's live plan/progress checklist — the
 * signature Claude Code progress UX. The model re-issues the whole list each
 * update, so PartList renders only the latest TodoWrite part; this shows it as
 * one evolving checklist. Header carries the done/total count; the in-progress
 * item is the collapsed preview. */
export function TodoActivity({ part }: { part: ToolPart }) {
  const todos = ((part.input ?? {}) as { todos?: Todo[] }).todos ?? []
  if (todos.length === 0) return null

  const done = todos.filter((t) => t.status === 'completed').length
  const active = todos.find((t) => t.status === 'in_progress')
  const preview = active?.activeForm || active?.content || undefined

  return (
    <ActivityRow
      icon={<IconChecklist size={14} />}
      label={`Plan ${done}/${todos.length}`}
      preview={preview}
      detail={
        <ul className="space-y-1.5">
          {todos.map((t, i) => (
            <TodoItem key={i} todo={t} />
          ))}
        </ul>
      }
      defaultOpen
    />
  )
}

function TodoItem({ todo }: { todo: Todo }) {
  const text =
    todo.status === 'in_progress' ? todo.activeForm || todo.content : todo.content
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0">
        {todo.status === 'completed' ? (
          <IconCircleCheck size={15} className="text-success" />
        ) : todo.status === 'in_progress' ? (
          <IconCircleDot size={15} className="text-foreground" />
        ) : (
          <IconCircle size={15} className="text-muted-foreground/50" />
        )}
      </span>
      <span
        className={cn(
          'min-w-0',
          todo.status === 'completed' && 'text-muted-foreground/60 line-through',
          todo.status === 'in_progress' && 'text-foreground',
          todo.status === 'pending' && 'text-muted-foreground',
        )}
      >
        {text}
      </span>
    </li>
  )
}
