// Left category rail for the settings modal. A plain button list driven by `active` —
// flexible enough to grow (icons, groups) without fighting a Tabs abstraction. Add a
// category here + its content panel in SettingsDialog; nothing else changes.

import { cn } from '@/lib/utils'

export const SETTINGS_CATEGORIES = [
  { id: 'general', label: 'General' },
  { id: 'files', label: 'Files & Notes' },
] as const

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number]['id']

export function SettingsNav({
  active,
  onSelect,
}: {
  active: SettingsCategory
  onSelect: (id: SettingsCategory) => void
}) {
  return (
    <nav className="w-48 shrink-0 space-y-0.5 border-r border-border bg-muted/30 p-2">
      {SETTINGS_CATEGORIES.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onSelect(c.id)}
          className={cn(
            'w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
            active === c.id
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          {c.label}
        </button>
      ))}
    </nav>
  )
}
