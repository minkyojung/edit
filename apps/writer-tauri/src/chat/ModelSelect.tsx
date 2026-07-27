// Per-thread model picker. A compact dropdown that sits in the PromptInput
// footer; the value is stored on ThreadMeta so each thread remembers its
// own choice. Disabled while a turn is streaming — switching mid-flight
// would mismatch the in-flight prompt with the new model on retry.
//
// Shares the ModeToggle popup design (icon + title + description + check on the
// active row, wide rounded panel) so the two footer pickers read as one system.

import { useEffect, useMemo } from 'react'
import { IconCheck } from '@tabler/icons-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CHAT_MODELS, labelForModel, type ChatModel, type ModelInfo } from '@/chat/types'
import {
  familyKey,
  meetsVersionFloor,
  mergeModelCatalog,
  splitByRecency,
  type MergedModel,
} from '@/chat/modelCatalog'
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

  // The fetched catalog (GET /v1/models). Null before the first successful
  // fetch and with nothing cached; the merge below then yields exactly the
  // built-in list, so the picker behaves as it always did.
  const catalog = useAvailableModelsStore((s) => s.catalog)

  const { primary, older } = useMemo(() => {
    const merged = mergeModelCatalog(CHAT_MODELS, catalog)

    // supportedModels() lists enabled models by opaque CLI alias (default /
    // opus / haiku) but reports a model the account *can't* use by its real id
    // with a "disabled"/"unavailable" marker in its name/description (e.g.
    // region-gated Fable). So default to showing every model and hide only the
    // ones explicitly flagged disabled — which means a model the user gains
    // access to (moving regions, plan change) reappears on its own.
    const isDisabledFlag = (a: ModelInfo) => {
      const text = `${a.displayName ?? ''} ${a.description ?? ''}`.toLowerCase()
      return text.includes('disabled') || text.includes('unavailable')
    }
    const idMatches = (flagged: string, id: string) =>
      flagged === id || flagged.startsWith(id) || id.startsWith(flagged)
    const isDisabled = (id: string) =>
      (available ?? []).some((a) => isDisabledFlag(a) && idMatches(a.value, id))

    // Drop models older than their family floor — the catalog reaches back to
    // Opus 4.1, which answers as Opus 4.8. The SELECTED model is exempt: a
    // thread pinned to an old model would otherwise have no matching row, and
    // the trigger would render a checkmark against nothing.
    const visible = merged.filter(
      (m) => !isDisabled(m.id) && (meetsVersionFloor(m.id) || familyKey(m.id) === familyKey(value)),
    )
    // Never strand the user with an empty picker if every model somehow reads
    // as disabled (unexpected payload shape).
    return splitByRecency(visible.length > 0 ? visible : merged, CHAT_MODELS)
    // `value` is a dependency because the floor exempts the selected model —
    // switching threads changes which below-floor row must stay visible.
  }, [available, catalog, value])

  const renderItem = (m: MergedModel) => (
    <DropdownMenuItem
      key={m.id}
      // The catalog can name a model that isn't in the ChatModel union — that's
      // the point of fetching it. The union is a compile-time convenience, not a
      // runtime guarantee, and every id-keyed lookup falls back safely (see
      // labelForModel / effortsForModel / contextLimitForModel).
      onSelect={() => onChange(m.id as ChatModel)}
      className="items-center gap-2.5 rounded-lg px-2.5 py-1.5"
    >
      <span className="min-w-0 flex-1 text-body font-medium">{labelForModel(m.id)}</span>
      {m.id === value && <IconCheck className="size-4 shrink-0 text-muted-foreground" stroke={2} />}
    </DropdownMenuItem>
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Model: ${labelForModel(value)}`}
        className={cn(
          'inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-body text-muted-foreground transition-colors',
          'hover:bg-accent hover:text-foreground',
          'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        {labelForModel(value)}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-44 rounded-xl p-1">
        <DropdownMenuLabel className="px-2.5 text-footnote text-muted-foreground">
          Model
        </DropdownMenuLabel>
        {primary.map((m) => renderItem(m))}
        {older.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="px-2.5 text-footnote text-muted-foreground">
              Older
            </DropdownMenuLabel>
            {older.map((m) => renderItem(m))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
