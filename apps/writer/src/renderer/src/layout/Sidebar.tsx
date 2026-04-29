import React from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { Note01Icon, LibraryIcon, Settings01Icon, FilterIcon, ArrowUpDownIcon } from '@hugeicons/core-free-icons'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from '@/components/ui/sidebar'

export function AppSidebar() {
  return (
    <Sidebar
      className="border-r"
      style={{ '--sidebar': 'transparent' } as React.CSSProperties}
    >
      <SidebarHeader className="flex flex-row items-center h-10 p-0">
        <div className="w-[72px] h-full shrink-0 [-webkit-app-region:drag]" />
        <div className="[-webkit-app-region:no-drag]">
          <SidebarTrigger />
        </div>
      </SidebarHeader>

      <SidebarContent className="px-2 pt-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton>
              <HugeiconsIcon icon={Note01Icon} className="size-4" strokeWidth={1.5} />
              Notes
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton>
              <HugeiconsIcon icon={LibraryIcon} className="size-4" strokeWidth={1.5} />
              Wiki
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg">
                  <Avatar className="size-7 shrink-0">
                    <AvatarImage src="" />
                    <AvatarFallback className="text-xs">WJ</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">William Jung</p>
                    <p className="text-xs text-muted-foreground truncate">Free Plan</p>
                  </div>
                  <HugeiconsIcon icon={ArrowUpDownIcon} className="ml-auto size-3.5 text-muted-foreground" strokeWidth={1.5} />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-52">
                <DropdownMenuItem>
                  <HugeiconsIcon icon={Settings01Icon} className="size-4" strokeWidth={1.5} />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <HugeiconsIcon icon={FilterIcon} className="size-4" strokeWidth={1.5} />
                  Filter
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive">
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
