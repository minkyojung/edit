import { useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  IconSettings,
  IconFilter,
  IconSelector,
  IconLogout,
  IconSparkles,
  IconBrandGithub,
  IconEdit,
  IconSearch,
} from '@tabler/icons-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { FolderTree } from './FolderTree'
import { WikiMetaRows } from './WikiMetaRows'
import { IngestProposalCard } from './IngestProposalCard'
import { useDocsStore } from '@/state/docsStore'
import { useCommandPaletteStore } from '@/state/commandPaletteStore'
import { buildViewUrl } from '@/lib/viewUrl'
import { ConnectClaudeDialog } from '@/components/auth/ConnectClaudeDialog'
import { ConnectGitHubDialog } from '@/components/auth/ConnectGitHubDialog'
import { useClaudeAuth } from '@/hooks/useClaudeAuth'
import { useGitHubAuth } from '@/hooks/useGitHubAuth'
import { useConnectDialog } from '@/stores/connectDialog'
import { useConnectGitHubDialog } from '@/stores/connectGitHubDialog'
import { useTheme } from '@/components/theme-provider'
import { useFont, type FontOption } from '@/components/font-provider'
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
  value: 'charcoal' | 'graphite' | 'olive' | 'paper' | 'mist'
  label: string
  swatch: { bg: string; fg: string; accent: string; border: string }
}

const PALETTE_OPTIONS: PaletteOption[] = [
  {
    value: 'charcoal',
    label: 'Charcoal',
    swatch: { bg: '#141414', fg: '#ECECEC', accent: '#262626', border: '#333333' },
  },
  {
    value: 'graphite',
    label: 'Graphite',
    swatch: { bg: '#1D2024', fg: '#ECECEE', accent: '#2B2C32', border: '#383940' },
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
  {
    value: 'mist',
    label: 'Mist',
    swatch: { bg: '#E9EAEC', fg: '#1D2024', accent: '#CFD1D4', border: '#B8BABE' },
  },
]

type FontOptionDef = {
  value: FontOption
  label: string
  /** Inline font-family used for the swatch so each row previews its
   * own typeface — Geist row in Geist, Nunito row in Nunito. */
  preview: string
}

const FONT_OPTIONS: FontOptionDef[] = [
  { value: 'pretendard', label: 'Pretendard', preview: "'Pretendard Variable', sans-serif" },
  { value: 'geist', label: 'Geist', preview: "'Geist Variable', sans-serif" },
  { value: 'nunito', label: 'Nunito Sans', preview: "'Nunito Sans Variable', sans-serif" },
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
  const { font, setFont } = useFont()
  const connectOpen = useConnectDialog((s) => s.open)
  const setConnectOpen = useConnectDialog((s) => s.setOpen)
  const { account, refresh, disconnect } = useClaudeAuth()
  const githubConnectOpen = useConnectGitHubDialog((s) => s.open)
  const setGithubConnectOpen = useConnectGitHubDialog((s) => s.setOpen)
  const {
    account: githubAccount,
    refresh: refreshGithub,
    disconnect: disconnectGithub,
  } = useGitHubAuth()
  const handleSignOut = useCallback(async () => {
    if (account.connected) {
      await disconnect()
    }
  }, [account.connected, disconnect])

  const createNew = useDocsStore((s) => s.createNew)
  const openPalette = useCommandPaletteStore((s) => s.openPalette)
  const navigate = useNavigate()

  // New flat note (lands at inbox/Untitled.md) → open it. Shared by the
  // header "+" button and the ⌘N shortcut so there's one code path.
  const handleCreateNew = useCallback(() => {
    createNew().then((slug) => {
      const store = useDocsStore.getState()
      navigate(
        buildViewUrl({
          tab: store.sidebarTab,
          dayAnchor: store.dayAnchor,
          monthAnchor: store.monthAnchor,
          slug,
        }),
      )
    }).catch((err) => console.error('[docs] createNew failed', err))
  }, [createNew, navigate])

  // ⌘N → new note. The vault is flat now, so a new note no longer nests
  // under today's daily — it's just a fresh file.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.shiftKey || e.altKey) return
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        handleCreateNew()
      }
    }
    // Capture phase so the editor / chat input / any descendant that
    // calls stopPropagation in its own keydown can't swallow the
    // shortcut. ⌘N is a global doc action; it needs to win over local
    // input handling.
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [handleCreateNew])

  return (
    <Sidebar>
      <SidebarHeader
        data-tauri-drag-region
        className="flex flex-row items-center p-0 pr-3"
        style={{ height: 'var(--header-h)' }}
      >
        {/* Reserve the macOS traffic-light area as a drag region so
            the OS dots paint over our chrome rather than over a real
            button. Same width token as EditorHeader so the two
            headers line up across the sidebar boundary. */}
        <div
          data-tauri-drag-region
          className="h-full shrink-0"
          style={{ width: 'var(--traffic-light-w)' }}
        />
        {/* Drag region fills the gap; the new-note action sits at the
            right edge (the space freed when the day/week/month switcher
            was removed). Outside the drag region so it stays clickable. */}
        <div data-tauri-drag-region className="flex-1 h-full" />
        <button
          type="button"
          aria-label="Search"
          title="Search (⌘K)"
          onClick={() => openPalette()}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <IconSearch size={16} stroke={1.75} />
        </button>
        <button
          type="button"
          aria-label="New note"
          title="New note (⌘N)"
          onClick={handleCreateNew}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <IconEdit size={16} stroke={1.75} />
        </button>
      </SidebarHeader>

      <SidebarContent>
        {/* Obsidian-style folder tree — the vault's folder structure is
            the sidebar. (Replaced the day/week/month date views.) */}
        <FolderTree />
      </SidebarContent>

      <SidebarFooter>
        {/* Karpathy Memories card — surfaces the queued ingest
            proposals so they're easy to notice without crowding the
            doc tree above. */}
        <IngestProposalCard />
        <SidebarMenu>
          {/* Profile + Conventions: always-present, low-frequency wiki
              surfaces. */}
          <WikiMetaRows />
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" className="px-2 h-9 rounded-xl hover:bg-transparent">
                  <Avatar className="size-4 shrink-0 opacity-80 group-hover/menu-button:opacity-100">
                    <AvatarImage src="" />
                    <AvatarFallback className="avatar-luma text-[9px] text-primary-foreground font-medium">
                      {accountInitials(account.email)}
                    </AvatarFallback>
                  </Avatar>
                  <p className="flex-1 min-w-0 text-sm font-medium text-sidebar-foreground/70 truncate group-hover/menu-button:text-sidebar-foreground">
                    {accountDisplayName(account.email) ?? 'Guest'}
                  </p>
                  <IconSelector size={14} stroke={1.5} className="ml-auto text-sidebar-foreground/60 group-hover/menu-button:text-sidebar-foreground" />
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
                {!githubAccount.connected && (
                  <>
                    <DropdownMenuItem onClick={() => setGithubConnectOpen(true)}>
                      <IconBrandGithub size={16} stroke={1.5} />
                      Connect GitHub
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {githubAccount.connected && (
                  <>
                    <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
                      GitHub
                    </DropdownMenuLabel>
                    <DropdownMenuItem disabled className="opacity-100">
                      <IconBrandGithub size={16} stroke={1.5} />
                      <span className="truncate">
                        {githubAccount.login ?? 'Connected'}
                      </span>
                    </DropdownMenuItem>
                    {/* Backup to GitHub removed — versioning/backup is being
                        redesigned as an opt-in layer; GitHub login stays. */}
                    <DropdownMenuItem onClick={disconnectGithub}>
                      Disconnect GitHub
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem disabled title="Coming soon">
                  <IconSettings size={16} stroke={1.5} />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem disabled title="Coming soon">
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
                <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
                  Font
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={font}
                  onValueChange={(v) => setFont(v as FontOption)}
                >
                  {FONT_OPTIONS.map((opt) => (
                    <DropdownMenuRadioItem
                      key={opt.value}
                      value={opt.value}
                      style={{ fontFamily: opt.preview }}
                    >
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
      <ConnectGitHubDialog
        open={githubConnectOpen}
        onOpenChange={setGithubConnectOpen}
        onConnected={() => {
          void refreshGithub()
        }}
      />
    </Sidebar>
  )
}
