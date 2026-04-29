import React, { useEffect, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

const MODEL_LABELS: Record<AgentModelId, string> = {
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-opus-4-7': 'Opus 4.7'
}

const EFFORT_LABELS: Record<AgentEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max'
}

const MODEL_EFFORTS: Record<AgentModelId, AgentEffort[]> = {
  'claude-haiku-4-5': ['low', 'medium', 'high'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max']
}

export function AgentSettingsChip(): React.ReactElement | null {
  const [settings, setSettings] = useState<AgentSettings | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    window.agent.getSettings().then(setSettings).catch(() => {
      // fall back to silent default if IPC fails
    })
  }, [])

  if (!settings) return null

  const allowedEfforts = MODEL_EFFORTS[settings.model]

  const apply = async (next: AgentSettings): Promise<void> => {
    setPending(true)
    try {
      const saved = await window.agent.setSettings(next)
      setSettings(saved)
    } finally {
      setPending(false)
    }
  }

  const onModelChange = (raw: string): void => {
    const model = raw as AgentModelId
    const efforts = MODEL_EFFORTS[model]
    const effort: AgentEffort = efforts.includes(settings.effort) ? settings.effort : 'low'
    apply({ model, effort })
  }

  const onEffortChange = (raw: string): void => {
    apply({ model: settings.model, effort: raw as AgentEffort })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={pending}
        className="fixed bottom-3 left-3 z-30 inline-flex items-center gap-2 rounded-full border border-border bg-background/80 px-3 py-1 font-sans text-xs text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground disabled:opacity-50 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="font-medium text-foreground">{MODEL_LABELS[settings.model]}</span>
        <span className="text-muted-foreground/80">·</span>
        <span>{EFFORT_LABELS[settings.effort]}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-44">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Model</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={settings.model} onValueChange={onModelChange}>
          {(Object.keys(MODEL_LABELS) as AgentModelId[]).map((m) => (
            <DropdownMenuRadioItem key={m} value={m}>
              {MODEL_LABELS[m]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Effort</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={settings.effort} onValueChange={onEffortChange}>
          {allowedEfforts.map((e) => (
            <DropdownMenuRadioItem key={e} value={e}>
              {EFFORT_LABELS[e]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
