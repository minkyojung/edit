import { Toaster } from 'sonner'
import { useTheme } from '@/components/theme-provider'

const DARK_PALETTES = new Set(['charcoal', 'graphite', 'olive'])

export function AppToaster() {
  const { palette } = useTheme()
  const theme = DARK_PALETTES.has(palette) ? 'dark' : 'light'
  return (
    <Toaster
      position="bottom-right"
      theme={theme}
      richColors
      closeButton={false}
      duration={5000}
      toastOptions={{
        classNames: {
          toast: 'rounded-md border border-border bg-popover text-popover-foreground shadow-md',
          description: 'text-muted-foreground',
          actionButton: 'rounded-sm bg-primary text-primary-foreground',
        },
      }}
    />
  )
}
