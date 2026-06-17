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
  IconFolderPlus,
  IconArrowsSort,
} from '@tabler/icons-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { FolderTree } from './FolderTree'
import { WikiMetaRows } from './WikiMetaRows'
import { IngestProposalCard } from './IngestProposalCard'
import { useDocsStore } from '@/state/docsStore'
import { useCommandPaletteStore } from '@/state/commandPaletteStore'
import { useNewFolderStore } from '@/state/newFolderStore'
import { openSettings } from '@/settings/useSettingsDialog'
import { buildViewUrl } from '@/lib/viewUrl'
import { ConnectClaudeDialog } from '@/components/auth/ConnectClaudeDialog'
import { ConnectGitHubDialog } from '@/components/auth/ConnectGitHubDialog'
import { useClaudeAuth } from '@/hooks/useClaudeAuth'
import { useGitHubAuth } from '@/hooks/useGitHubAuth'
import { useConnectDialog } from '@/stores/connectDialog'
import { useConnectGitHubDialog } from '@/stores/connectGitHubDialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useSortStore, SORT_LABELS, type SortMode } from '@/state/sortStore'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
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

export function AppSidebar() {
  const connectOpen = useConnectDialog((s) => s.open)
  const setConnectOpen = useConnectDialog((s) => s.setOpen)
  const { account, refresh, disconnect } = useClaudeAuth()
  const githubConnectOpen = useConnectGitHubDialog((s) => s.open)
  const setGithubConnectOpen = useConnectGitHubDialog((s) => s.setOpen)
  const {
    account: githubAccount,
    refresh: refreshGithub,
  } = useGitHubAuth()
  const handleSignOut = useCallback(async () => {
    if (account.connected) {
      await disconnect()
    }
  }, [account.connected, disconnect])

  const createNew = useDocsStore((s) => s.createNew)
  const openPalette = useCommandPaletteStore((s) => s.openPalette)
  const startNewFolder = useNewFolderStore((s) => s.start)
  const sortMode = useSortStore((s) => s.mode)
  const setSortMode = useSortStore((s) => s.setMode)
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Sort"
              title="Sort"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <IconArrowsSort size={16} stroke={1.75} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={sortMode}
              onValueChange={(v) => setSortMode(v as SortMode)}
            >
              {(Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
                <DropdownMenuRadioItem key={m} value={m}>
                  {SORT_LABELS[m]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-label="New folder"
          title="New folder"
          onClick={startNewFolder}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <IconFolderPlus size={16} stroke={1.75} />
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
            {/* Profile row: avatar + name (display), then the settings gear,
                then the account-menu chevron. Each control is its own button
                — the gear opens the settings modal, the chevron opens the
                account dropdown. */}
            <div className="flex h-9 items-center gap-0.5 rounded-xl px-2">
              <Avatar className="size-4 shrink-0 opacity-80">
                <AvatarImage src="" />
                <AvatarFallback className="avatar-luma text-[9px] text-primary-foreground font-medium">
                  {accountInitials(account.email)}
                </AvatarFallback>
              </Avatar>
              <p className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/70">
                {accountDisplayName(account.email) ?? 'Guest'}
              </p>
              <button
                type="button"
                aria-label="Settings"
                title="Settings"
                onClick={() => openSettings()}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
              >
                <IconSettings size={16} stroke={1.5} />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Account menu"
                    title="Account"
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  >
                    <IconSelector size={14} stroke={1.5} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="end" className="w-52">
                {/* The dropdown only *shows* the connected identities — managing
                    them (connect/disconnect) lives in Settings → Connections, so
                    settings stay the single home for connections. */}
                {(account.connected || githubAccount.connected) && (
                  <>
                    {account.connected && (
                      <DropdownMenuItem disabled className="opacity-100">
                        <IconSparkles size={16} stroke={1.5} />
                        <span className="truncate">{account.email ?? 'Claude'}</span>
                      </DropdownMenuItem>
                    )}
                    {githubAccount.connected && (
                      <DropdownMenuItem disabled className="opacity-100">
                        <IconBrandGithub size={16} stroke={1.5} />
                        <span className="truncate">
                          {githubAccount.login ?? 'GitHub'}
                        </span>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={() => openSettings('connections')}>
                  <IconSettings size={16} stroke={1.5} />
                  Manage connections…
                </DropdownMenuItem>
                <DropdownMenuItem disabled title="Coming soon">
                  <IconFilter size={16} stroke={1.5} />
                  Filter
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onClick={handleSignOut}>
                  <IconLogout size={16} stroke={1.5} />
                  Sign out
                </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
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
