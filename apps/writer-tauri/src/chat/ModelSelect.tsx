// Per-thread model picker. A compact dropdown that sits in the PromptInput
// footer; the value is stored on ThreadMeta so each thread remembers its
// own choice. Disabled while a turn is streaming — switching mid-flight
// would mismatch the in-flight prompt with the new model on retry.

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CHAT_MODELS, CHAT_MODEL_LABELS, type ChatModel } from '@/chat/types'
import { cn } from '@/lib/utils'

interface Props {
  value: ChatModel
  onChange: (next: ChatModel) => void
  disabled?: boolean
}

export function ModelSelect({ value, onChange, disabled }: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(
          'inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-sm text-muted-foreground transition-colors',
          'hover:bg-accent hover:text-foreground',
          'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        {CHAT_MODEL_LABELS[value]}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="min-w-36">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Model</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as ChatModel)}>
          {CHAT_MODELS.map((m) => (
            <DropdownMenuRadioItem key={m} value={m} className="text-xs">
              {CHAT_MODEL_LABELS[m]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
