import { useCallback, useEffect, useState } from 'react'
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
import { FolderTree } from './FolderTree'
import { WikiMetaRows } from './WikiMetaRows'
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
  SidebarMenuButton,
  SidebarMenuAction,
} from '@/components/ui/sidebar'

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
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
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
    // The sidebar container's default `border-r` uses the translucent
    // `--border` token (oklch(1 0 0 / 8–10%) in the dark themes). With the
    // window transparent for vibrancy, that 1px border sits over the
    // transparent layout gap and reveals the desktop as a seam at the
    // sidebar↔editor boundary. Paint it with the opaque `--sidebar` color so
    // it covers rather than bleeds (seamless, no desktop show-through).
    <Sidebar className="[border-right-color:var(--sidebar)]">
      <SidebarHeader
        data-tauri-drag-region
        className="flex flex-row items-center gap-1 p-0 pr-3"
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
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-foreground/12 hover:text-sidebar-foreground"
        >
          <IconSearch size={18} stroke={1.75} />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Sort"
              title="Sort"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-foreground/12 hover:text-sidebar-foreground"
            >
              <IconArrowsSort size={18} stroke={1.75} />
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
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-foreground/12 hover:text-sidebar-foreground"
        >
          <IconFolderPlus size={18} stroke={1.75} />
        </button>
        <button
          type="button"
          aria-label="New note"
          title="New note (⌘N)"
          onClick={handleCreateNew}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-foreground/12 hover:text-sidebar-foreground"
        >
          <IconEdit size={18} stroke={1.75} />
        </button>
      </SidebarHeader>

      <SidebarContent>
        {/* Obsidian-style folder tree — the vault's folder structure is
            the sidebar. (Replaced the day/week/month date views.) */}
        <FolderTree />
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {/* Profile + Conventions: always-present, low-frequency wiki
              surfaces. */}
          <WikiMetaRows />
          <DropdownMenu open={accountMenuOpen} onOpenChange={setAccountMenuOpen}>
            <SidebarMenuItem>
              {/* Identity uses the SidebarMenuButton primitive so it inherits the
                  EXACT radius / height / padding / full-width hover of the nav rows
                  above (the shared SIDEBAR_ROW_INTERACTION skin). The gear and
                  chevron float on top as SidebarMenuActions, so the whole row
                  highlights as one unit instead of looking segmented. pr-14 keeps
                  the name clear of both trailing actions. */}
              <SidebarMenuButton
                aria-label="Account"
                // Bottom-left corner echoes the window's rounded corner it sits in.
                // The sidebar is flush to the window (side=left, left-0) and the
                // footer's p-2 inset equals --window-inset, so the concentric value
                // is exactly --window-radius − --window-inset (≈18px). Other corners
                // keep the nav-row rounded-sm.
                className="pr-14 text-sidebar-foreground/70 rounded-bl-[calc(var(--window-radius)-var(--window-inset))]"
                onClick={() => setAccountMenuOpen(true)}
              >
                <span className="flex-1 truncate">
                  {accountDisplayName(account.email) ?? 'Guest'}
                </span>
              </SidebarMenuButton>
              <SidebarMenuAction
                aria-label="Settings"
                title="Settings"
                className="right-7"
                onClick={() => openSettings()}
              >
                <IconSettings stroke={1.5} />
              </SidebarMenuAction>
              <DropdownMenuTrigger asChild>
                <SidebarMenuAction aria-label="Account menu" title="Account">
                  <IconSelector stroke={1.5} />
                </SidebarMenuAction>
              </DropdownMenuTrigger>
            </SidebarMenuItem>
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
