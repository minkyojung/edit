import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  IconBooks,
  IconSettings,
  IconFilter,
  IconSelector,
  IconLogout,
  IconSparkles,
} from '@tabler/icons-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import { DocList } from './DocList'
import { useDocsStore } from '@/state/docsStore'
import { ConnectClaudeDialog } from '@/components/auth/ConnectClaudeDialog'
import { useClaudeAuth } from '@/hooks/useClaudeAuth'
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

/** Pull initials from an email's local part, splitting on .+_- so
 * william.jung@x.com → WJ. Falls back to the first letter, then "?" so
 * the avatar always renders something. */
function accountInitials(email: string | null): string {
  if (!email) return '?'
  const local = email.split('@')[0] ?? ''
  const parts = local.split(/[._-]+/).filter(Boolean)
  if (parts.length === 0) return (local[0] ?? '?').toUpperCase()
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/** Capitalize the email's local part for a friendly-but-honest display
 * name. Returns null when there's no email so callers can render a
 * generic placeholder. */
function accountDisplayName(email: string | null): string | null {
  if (!email) return null
  const local = email.split('@')[0] ?? ''
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(' ')
}

type PaletteOption = {
  value: 'charcoal' | 'olive' | 'paper'
  label: string
  swatch: { bg: string; fg: string; accent: string; border: string }
}

const NAV_ITEMS = [
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

interface AppSidebarProps {
  /** Collab status surfaced as small text in the header — only rendered
   * while the doc is mid-handshake or in error so a connected doc reads
   * as a clean header. */
  collabStatus?: 'initializing' | 'connecting' | 'connected' | 'error'
}

const STATUS_LABEL: Record<NonNullable<AppSidebarProps['collabStatus']>, string | null> = {
  initializing: 'Starting…',
  connecting: 'Connecting…',
  connected: null,
  error: 'Offline',
}

export function AppSidebar({ collabStatus }: AppSidebarProps = {}) {
  const { palette, setPalette } = useTheme()
  const { pathname } = useLocation()
  const [connectOpen, setConnectOpen] = useState(false)
  const { account, refresh, disconnect } = useClaudeAuth()

  const handleSignOut = useCallback(async () => {
    if (account.connected) {
      await disconnect()
    }
  }, [account.connected, disconnect])

  const statusLabel = collabStatus ? STATUS_LABEL[collabStatus] : null
  const openDaily = useDocsStore((s) => s.openDaily)
  const navigate = useNavigate()

  // ⌘T → today's daily journal entry. Lands on the editor route in
  // case the user is currently looking at /wiki when they press it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.shiftKey || e.altKey) return
      if (e.key !== 't' && e.key !== 'T') return
      e.preventDefault()
      openDaily().catch((err) =>
        console.error('[docs] ⌘T openDaily failed', err),
      )
      if (!pathname.startsWith('/notes')) navigate('/notes')
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [openDaily, navigate, pathname])

  return (
    <Sidebar
      className="border-r"
    >
      <SidebarHeader
        className="flex flex-row items-center gap-2 p-0 px-2"
        style={{ height: 'var(--header-h)' }}
      >
        <div data-tauri-drag-region className="flex-1 h-full" />
        {statusLabel && (
          <span
            className={cn(
              'text-xs',
              collabStatus === 'error' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {statusLabel}
          </span>
        )}
        <SidebarTrigger />
      </SidebarHeader>

      <SidebarContent className="pt-1">
        <DocList />
        <SidebarMenu className="gap-0 px-2 pt-2">
          {NAV_ITEMS.map((item) => (
            <SidebarMenuItem key={item.url}>
              <SidebarMenuButton
                asChild
                isActive={pathname.startsWith(item.url)}
                className="h-auto py-2 font-medium"
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
                    <AvatarFallback className="avatar-luma text-xs text-primary-foreground font-medium">
                      {accountInitials(account.email)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">
                      {accountDisplayName(account.email) ?? 'Guest'}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {account.connected ? (account.email ?? 'Connected') : 'Not connected'}
                    </p>
                  </div>
                  <IconSelector size={14} stroke={1.5} className="ml-auto text-muted-foreground" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-52">
                {!account.connected && (
                  <>
                    <DropdownMenuItem onClick={() => setConnectOpen(true)}>
                      <IconSparkles size={16} stroke={1.5} />
                      Connect Claude
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {account.connected && (
                  <>
                    <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
                      Claude
                    </DropdownMenuLabel>
                    <DropdownMenuItem disabled className="opacity-100">
                      <IconSparkles size={16} stroke={1.5} />
                      <span className="truncate">{account.email ?? 'Connected'}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={disconnect}>
                      Disconnect Claude
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
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
      <ConnectClaudeDialog open={connectOpen} onOpenChange={setConnectOpen} onConnected={refresh} />
    </Sidebar>
  )
}
