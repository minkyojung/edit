import { useCallback, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  IconNote,
  IconBooks,
  IconSettings,
  IconFilter,
  IconSelector,
  IconLogout,
  IconSparkles,
} from '@tabler/icons-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ConnectClaudeDialog } from '@/components/auth/ConnectClaudeDialog'
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

type PaletteOption = {
  value: 'charcoal' | 'olive' | 'paper'
  label: string
  swatch: { bg: string; fg: string; accent: string; border: string }
}

const NAV_ITEMS = [
  { title: 'Notes', url: '/notes', icon: IconNote },
  { title: 'Wiki', url: '/wiki', icon: IconBooks },
] as const

const PALETTE_OPTIONS: PaletteOption[] = [
  {
    value: 'charcoal',
    label: 'Charcoal',
    swatch: { bg: '#141414', fg: '#ECECEC', accent: '#262626', border: '#333333' },
  },
  {
    value: 'olive',
    label: 'Olive',
    swatch: { bg: '#111001', fg: '#E8E4D0', accent: '#26230C', border: '#3A3520' },
  },
  {
    value: 'paper',
    label: 'Paper',
    swatch: { bg: '#D2D2D2', fg: '#1A1A1A', accent: '#BCBCBC', border: '#A8A8A8' },
  },
]

function PaletteSwatch({ swatch }: { swatch: PaletteOption['swatch'] }) {
  return (
    <span
      className="inline-flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-full"
      style={{ backgroundColor: swatch.bg, boxShadow: `inset 0 0 0 1px ${swatch.border}` }}
      aria-hidden
    >
      <span
        className="block size-2 rounded-full"
        style={{ backgroundColor: swatch.fg }}
      />
    </span>
  )
}

export function AppSidebar() {
  const { palette, setPalette } = useTheme()
  const { pathname } = useLocation()
  const [connectOpen, setConnectOpen] = useState(false)

  // TODO(M7): wire to Tauri command
  const handleSignOut = useCallback(async () => {
    console.log('sign out — not yet implemented')
  }, [])

  return (
    <Sidebar
      className="border-r"
    >
      <SidebarHeader
        className="flex flex-row items-center p-0"
        style={{ height: '31px' }}
      >
        <div data-tauri-drag-region className="flex-1 h-full" />
        <SidebarTrigger />
      </SidebarHeader>

      <SidebarContent className="px-2 pt-1">
        <SidebarMenu className="gap-0">
          {NAV_ITEMS.map((item) => (
            <SidebarMenuItem key={item.url}>
              <SidebarMenuButton
                asChild
                isActive={pathname.startsWith(item.url)}
                className="py-1 font-medium"
              >
                <Link to={item.url}>
                  <item.icon size={16} stroke={1.5} />
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" className="px-2 h-11">
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
                <DropdownMenuItem onClick={() => setConnectOpen(true)}>
                  <IconSparkles size={16} stroke={1.5} />
                  Connect Claude
                </DropdownMenuItem>
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
                  Palette
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={palette}
                  onValueChange={(v) => setPalette(v as PaletteOption['value'])}
                >
                  {PALETTE_OPTIONS.map((opt) => (
                    <DropdownMenuRadioItem key={opt.value} value={opt.value}>
                      <PaletteSwatch swatch={opt.swatch} />
                      {opt.label}
                    </DropdownMenuRadioItem>
                  ))}
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
      <ConnectClaudeDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </Sidebar>
  )
}
