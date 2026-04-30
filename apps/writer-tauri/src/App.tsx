import { useEffect, useState } from 'react'
import { ThemeProvider } from '@/components/theme-provider'
import { AppShell } from '@/layout/AppShell'
import { MilkdownEditor } from '@/editor/MilkdownEditor'
import { waitUntilReady } from '@/lib/proofClient'

type ServerStatus = 'connecting' | 'ready' | 'error'

export function App() {
  const [_serverStatus, setServerStatus] = useState<ServerStatus>('connecting')

  useEffect(() => {
    waitUntilReady(15_000).then((ok) =>
      setServerStatus(ok ? 'ready' : 'error')
    )
  }, [])

  return (
    <ThemeProvider defaultTheme="dark" storageKey="writer-theme">
      <AppShell oauthStatus="unauthenticated">
        <MilkdownEditor />
      </AppShell>
    </ThemeProvider>
  )
}
