import { useState } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { ThemeProvider } from '@/components/theme-provider'
import { AppShell } from '@/layout/AppShell'
import { MilkdownEditor } from '@/editor/MilkdownEditor'
import { useCollabDoc } from '@/hooks/useCollabDoc'

export function App() {
  const { handle, status } = useCollabDoc()
  const [view, setView] = useState<EditorView | null>(null)

  return (
    <ThemeProvider defaultPalette="charcoal" storageKey="writer-palette">
      <AppShell oauthStatus="unauthenticated" collabHandle={handle} editorView={view}>
        <MilkdownEditor handle={handle} status={status} onViewReady={setView} />
      </AppShell>
    </ThemeProvider>
  )
}
