// TODO(M7): full ContextPanel with Tauri commands — stub for M1 shell validation

interface Props {
  documentContext: string | null
  oauthStatus: 'authenticated' | 'unauthenticated' | 'checking'
}

export function ContextPanel(_props: Props) {
  return (
    <div className="flex h-full flex-col border-l border-border bg-background p-4">
      <p className="text-xs text-muted-foreground">Context panel (M7)</p>
    </div>
  )
}
