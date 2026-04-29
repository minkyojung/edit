import React from 'react'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
} from '@/components/ui/sidebar'

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

function NoteTreeItem({ item }: { item: NoteItem }) {
  if (!item.children?.length) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton>
          {item.title}
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton>{item.title}</SidebarMenuButton>
      <SidebarMenuSub>
        {item.children.map((child) => (
          <SidebarMenuSubItem key={child.id}>
            <SidebarMenuSubButton>{child.title}</SidebarMenuSubButton>
          </SidebarMenuSubItem>
        ))}
      </SidebarMenuSub>
    </SidebarMenuItem>
  )
}

export function AppSidebar() {
  return (
    <Sidebar>
      {/* 신호등 버튼 공간 + 드래그 영역 */}
      <SidebarHeader className="h-10 [-webkit-app-region:drag] p-0" />

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>오늘 {todayLabel}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {mockNotes.map((note) => (
                <NoteTreeItem key={note.id} item={note} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupLabel>위키</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {mockWikiItems.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton>{item.title}</SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
