// One row of the note properties panel: a fixed-width, muted `[icon] label`
// column on the left and the value control on the right, aligned to a common
// left edge across rows (the Notion property look). The row is a quiet,
// hover-highlighted line — the value control decides whether it's editable.

import type { ReactNode } from 'react'

type IconComponent = React.ComponentType<{
  size?: number | string
  stroke?: number | string
  className?: string
}>

export function PropertyRow({
  icon: Icon,
  label,
  children,
}: {
  icon: IconComponent
  label: string
  children: ReactNode
}) {
  return (
    <div className="-mx-1.5 flex min-h-7 items-center gap-2 rounded-md px-1.5 transition-colors hover:bg-accent/40">
      <div className="flex w-28 shrink-0 items-center gap-1.5 text-footnote text-muted-foreground">
        <Icon size={15} stroke={1.75} className="shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <div className="min-w-0 flex-1 text-body text-foreground">{children}</div>
    </div>
  )
}
