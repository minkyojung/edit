// One labeled setting: title + optional description on the left, the control on the
// right. THE reusable unit of the settings UI — every setting is a SettingRow, so the
// modal stays consistent and adding a setting is a single composition.

import type { ReactNode } from 'react'

export function SettingRow({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className="text-body font-medium text-foreground">{title}</div>
        {description && (
          <div className="mt-0.5 text-footnote text-muted-foreground">{description}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
