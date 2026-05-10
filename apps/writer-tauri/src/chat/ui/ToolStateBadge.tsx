import type React from 'react'
import { IconCheck, IconAlertTriangle, IconLoader2 } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import type { ToolPart } from '@/chat/types'

/** Renders the small status indicator next to a tool's name. Maps each
 * tool state to a Badge variant so the chat surface picks up its
 * info / success / warning / destructive tones from the theme tokens
 * rather than hand-rolled tailwind utilities. */
export function ToolStateBadge({ state }: { state: ToolPart['state'] }) {
  const meta: Record<
    ToolPart['state'],
    {
      icon: React.ReactNode
      label: string
      variant: React.ComponentProps<typeof Badge>['variant']
    }
  > = {
    'input-streaming': {
      icon: <IconLoader2 size={12} className="animate-spin" />,
      label: 'preparing',
      variant: 'secondary',
    },
    'input-available': {
      icon: <IconLoader2 size={12} className="animate-spin" />,
      label: 'running',
      variant: 'info',
    },
    'output-available': {
      icon: <IconCheck size={12} />,
      label: 'done',
      variant: 'success',
    },
    'output-error': {
      icon: <IconAlertTriangle size={12} />,
      label: 'error',
      variant: 'destructive',
    },
    'approval-requested': {
      icon: <IconAlertTriangle size={12} />,
      label: 'needs approval',
      variant: 'warning',
    },
  }
  const m = meta[state]
  return (
    <Badge variant={m.variant}>
      {m.icon}
      {m.label}
    </Badge>
  )
}
