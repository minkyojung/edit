type ServerStatus = 'connecting' | 'ready' | 'error'

const statusLabel: Record<ServerStatus, string> = {
  connecting: 'proof-server 연결 중…',
  ready: 'proof-server 연결됨 ✓',
  error: 'proof-server 연결 실패',
}

const statusColor: Record<ServerStatus, string> = {
  connecting: 'text-muted-foreground',
  ready: 'text-green-500',
  error: 'text-destructive',
}

export function EditorPlaceholder({ serverStatus = 'connecting' }: { serverStatus?: ServerStatus }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <div className="rounded-lg border border-dashed border-border bg-muted/30 px-16 py-12 text-center">
        <div className="text-sm text-muted-foreground">에디터 영역 (M3에서 구현)</div>
      </div>
      <span className={`text-xs ${statusColor[serverStatus]}`}>
        {statusLabel[serverStatus]}
      </span>
    </div>
  )
}
