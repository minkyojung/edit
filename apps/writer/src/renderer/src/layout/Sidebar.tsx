import React from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

interface NoteItem {
  id: string
  title: string
  children?: NoteItem[]
}

const mockNotes: NoteItem[] = [
  {
    id: '1',
    title: '회의 메모',
    children: [
      { id: '1-1', title: '결정사항' },
      { id: '1-2', title: '액션 아이템' },
    ],
  },
  { id: '2', title: '아이디어' },
  { id: '3', title: '독서 노트' },
]

const mockWikiItems: NoteItem[] = [
  { id: 'w1', title: 'belief' },
  { id: 'w2', title: 'entity' },
]

const todayLabel = new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })

function SidebarItem({ item, depth = 0 }: { item: NoteItem; depth?: number }) {
  return (
    <div>
      <button
        type="button"
        className={cn(
          'w-full text-left py-1 rounded-md text-sm text-sidebar-foreground',
          'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          'transition-colors'
        )}
        style={{ paddingLeft: `${8 + depth * 16}px`, paddingRight: '8px' }}
      >
        {item.title}
      </button>
      {item.children?.map((child) => (
        <SidebarItem key={child.id} item={child} depth={depth + 1} />
      ))}
    </div>
  )
}

export function Sidebar() {
  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="px-3 py-4">
        <p className="px-2 text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
          오늘 {todayLabel}
        </p>
        <div className="space-y-0.5">
          {mockNotes.map((note) => (
            <SidebarItem key={note.id} item={note} />
          ))}
        </div>
      </div>

      <Separator />

      <ScrollArea className="flex-1 px-3 py-3">
        <p className="px-2 text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
          위키
        </p>
        <div className="space-y-0.5">
          {mockWikiItems.map((item) => (
            <SidebarItem key={item.id} item={item} />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
