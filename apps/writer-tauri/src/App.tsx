import { ThemeProvider } from '@/components/theme-provider'
import { AppShell } from '@/layout/AppShell'
import { MilkdownEditor } from '@/editor/MilkdownEditor'
import { useCollabDoc } from '@/hooks/useCollabDoc'

export function App() {
  const { handle, status } = useCollabDoc()

  return (
    <ThemeProvider defaultTheme="dark" storageKey="writer-theme">
      <AppShell oauthStatus="unauthenticated" collabHandle={handle}>
        <MilkdownEditor handle={handle} status={status} />
      </AppShell>
    </ThemeProvider>
  )
}
