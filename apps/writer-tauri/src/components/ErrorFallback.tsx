// Fallback UI rendered when an ErrorBoundary catches a render error.
//
// Two flavors:
//  - <FullPageErrorFallback> — for the app-root boundary (last line of defense)
//  - <PanelErrorFallback>    — for a single panel boundary (e.g. ChatPanel)

import { IconAlertTriangle } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import type { FallbackProps } from 'react-error-boundary'

export function FullPageErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6">
      <div className="max-w-md space-y-3 rounded-md border border-border bg-card p-6 text-center">
        <IconAlertTriangle size={28} stroke={1.5} className="mx-auto text-destructive" />
        <h2 className="text-body font-medium text-foreground">Something went wrong</h2>
        <p className="text-footnote text-muted-foreground break-words">
          {error instanceof Error ? error.message : String(error)}
        </p>
        <div className="flex justify-center gap-2 pt-2">
          <Button size="sm" onClick={resetErrorBoundary}>Try again</Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    </div>
  )
}

export function PanelErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <div className="max-w-xs space-y-2 text-center">
        <IconAlertTriangle size={20} stroke={1.5} className="mx-auto text-destructive" />
        <p className="text-footnote text-muted-foreground break-words">
          {error instanceof Error ? error.message : String(error)}
        </p>
        <Button size="sm" variant="outline" onClick={resetErrorBoundary}>
          Try again
        </Button>
      </div>
    </div>
  )
}
