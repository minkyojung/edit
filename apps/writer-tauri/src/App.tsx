import { useEffect, useState } from 'react'
import { ThemeProvider } from '@/components/theme-provider'
import { AppShell } from '@/layout/AppShell'
import { EditorPlaceholder } from '@/components/EditorPlaceholder'
import { waitUntilReady } from '@/lib/proofClient'

type ServerStatus = 'connecting' | 'ready' | 'error'

export function App() {
  const [serverStatus, setServerStatus] = useState<ServerStatus>('connecting')

  useEffect(() => {
    waitUntilReady(15_000).then((ok) =>
      setServerStatus(ok ? 'ready' : 'error')
    )
  }, [])

  return (
    <ThemeProvider defaultTheme="dark" storageKey="writer-theme">
      <AppShell oauthStatus="unauthenticated">
        <EditorPlaceholder serverStatus={serverStatus} />
      </AppShell>
    </ThemeProvider>
  )
}
