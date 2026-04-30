import { ThemeProvider } from '@/components/theme-provider'
import { AppShell } from '@/layout/AppShell'
import { EditorPlaceholder } from '@/components/EditorPlaceholder'

export function App() {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="writer-theme">
      <AppShell oauthStatus="unauthenticated">
        <EditorPlaceholder />
      </AppShell>
    </ThemeProvider>
  )
}
