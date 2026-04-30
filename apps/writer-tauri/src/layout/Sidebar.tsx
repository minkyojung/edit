import React, { useCallback } from 'react'
import {
  IconNote,
  IconBooks,
  IconSettings,
  IconFilter,
  IconSelector,
  IconSun,
  IconMoon,
  IconDeviceDesktop,
  IconLogout,
} from '@tabler/icons-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { useTheme } from '@/components/theme-provider'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  const { theme, setTheme } = useTheme()

  // TODO(M7): wire to Tauri command
  const handleSignOut = useCallback(async () => {
    console.log('sign out — not yet implemented')
  }, [])

  return (
    <Sidebar
      className="border-r"
      style={{ '--sidebar': 'transparent' } as React.CSSProperties}
    >
      <SidebarHeader
        className="flex flex-row items-center p-0"
        style={{ height: 'env(titlebar-area-height, 31px)', paddingTop: 'env(titlebar-area-y, 0px)' }}
      >
        <div className="w-[72px] h-full shrink-0" data-tauri-drag-region />
        <SidebarTrigger />
        <div className="flex-1 h-full" data-tauri-drag-region />
      </SidebarHeader>

      <SidebarContent className="px-2 pt-1">
        <SidebarMenu className="gap-0">
          <SidebarMenuItem>
            <SidebarMenuButton className="py-1.5">
              <IconNote size={16} stroke={1.5} />
              Notes
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton className="py-1.5">
              <IconBooks size={16} stroke={1.5} />
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
                <SidebarMenuButton size="lg" className="px-2">
                  <Avatar className="size-7 shrink-0">
                    <AvatarImage src="" />
                    <AvatarFallback className="avatar-luma text-xs text-white font-medium">WJ</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">William Jung</p>
                    <p className="text-xs text-muted-foreground truncate">Free Plan</p>
                  </div>
                  <IconSelector size={14} stroke={1.5} className="ml-auto text-muted-foreground" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-52">
                <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
                  Connected to Claude
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem>
                  <IconSettings size={16} stroke={1.5} />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <IconFilter size={16} stroke={1.5} />
                  Filter
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
                  Theme
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={theme}
                  onValueChange={(v) => setTheme(v as 'light' | 'dark' | 'system')}
                >
                  <DropdownMenuRadioItem value="light">
                    <IconSun size={16} stroke={1.5} />
                    Light
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <IconMoon size={16} stroke={1.5} />
                    Dark
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    <IconDeviceDesktop size={16} stroke={1.5} />
                    System
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onClick={handleSignOut}>
                  <IconLogout size={16} stroke={1.5} />
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
