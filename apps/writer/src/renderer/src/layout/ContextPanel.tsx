import React from 'react'

export function ContextPanel() {
  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="px-4 py-4 border-b border-sidebar-border">
        <p className="text-sm font-medium">채팅</p>
      </div>
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs text-muted-foreground">채팅 패널 (준비 중)</p>
      </div>
    </div>
  )
}
