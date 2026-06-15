// Per-thread model picker. A compact dropdown that sits in the PromptInput
// footer; the value is stored on ThreadMeta so each thread remembers its
// own choice. Disabled while a turn is streaming — switching mid-flight
// would mismatch the in-flight prompt with the new model on retry.

import { useEffect, useMemo } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CHAT_MODELS, CHAT_MODEL_LABELS, type ChatModel } from '@/chat/types'
import { useAvailableModelsStore } from '@/state/availableModelsStore'
import { cn } from '@/lib/utils'

interface Props {
  value: ChatModel
  onChange: (next: ChatModel) => void
  disabled?: boolean
}

export function ModelSelect({ value, onChange, disabled }: Props) {
  // Hide models this account can't use (e.g. region-gated). `available` is null
  // until the sidecar answers; until then — and if the fetch fails — we show the
  // full built-in list, so the picker always works.
  const available = useAvailableModelsStore((s) => s.models)
  useEffect(() => {
    void useAvailableModelsStore.getState().load()
  }, [])

  const models = useMemo<readonly ChatModel[]>(() => {
    if (!available) return CHAT_MODELS
    // supportedModels() lists enabled models by opaque CLI alias (default /
    // opus / haiku) but reports a model the account *can't* use by its real id
    // with a "disabled"/"unavailable" marker in its name/description (e.g.
    // region-gated Fable). So default to showing every built-in model and hide
    // only the ones explicitly flagged disabled — which means a model the user
    // gains access to (moving regions, plan change) reappears on its own.
    const isDisabledFlag = (a: (typeof available)[number]) => {
      const text = `${a.displayName ?? ''} ${a.description ?? ''}`.toLowerCase()
      return text.includes('disabled') || text.includes('unavailable')
    }
    const idMatches = (value: string, m: ChatModel) =>
      value === m || value.startsWith(m) || m.startsWith(value)
    const isDisabled = (m: ChatModel) =>
      available.some((a) => isDisabledFlag(a) && idMatches(a.value, m))
    const filtered = CHAT_MODELS.filter((m) => !isDisabled(m))
    // Never strand the user with an empty picker if every model somehow reads
    // as disabled (unexpected payload shape).
    return filtered.length > 0 ? filtered : CHAT_MODELS
  }, [available])

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
          {models.map((m) => (
            <DropdownMenuRadioItem key={m} value={m} className="text-xs">
              {CHAT_MODEL_LABELS[m]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
