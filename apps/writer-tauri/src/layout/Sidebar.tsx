import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  IconSettings,
  IconEdit,
  IconSearch,
  IconFolderPlus,
  IconArrowsSort,
  IconUser,
  IconBolt,
  IconRobot,
  IconTerminal2,
  IconPalette,
  IconSparkles,
  IconCircleDashed,
} from '@tabler/icons-react'
import { FolderTree } from './FolderTree'
import { useDocsStore } from '@/state/docsStore'
import { useCommandPaletteStore } from '@/state/commandPaletteStore'
import { useNewFolderStore } from '@/state/newFolderStore'
import { openSettings } from '@/settings/useSettingsDialog'
import { ensureProfileWikiSlug } from '@/state/wikiService'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { openDoc } from '@/lib/openDoc'
import { ConnectClaudeDialog } from '@/components/auth/ConnectClaudeDialog'
import { ConnectGitHubDialog } from '@/components/auth/ConnectGitHubDialog'
import { useClaudeAuth } from '@/hooks/useClaudeAuth'
import { useGitHubAuth } from '@/hooks/useGitHubAuth'
import { useGoogleAuth } from '@/hooks/useGoogleAuth'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { useConnectDialog } from '@/stores/connectDialog'
import { useConnectGitHubDialog } from '@/stores/connectGitHubDialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useSortStore, SORT_LABELS, type SortMode } from '@/state/sortStore'
import { useStatusFilterStore } from '@/state/statusFilterStore'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from '@/components/ui/sidebar'
import { WhatsNewSidebar } from '@/components/WhatsNew'
import { SIDEBAR_ROW_INTERACTION } from '@/components/ui/sidebarRow'
import { cn } from '@/lib/utils'

// Vertical surface-list row: same geometry + shared interaction skin as the
// folder-tree rows (SIDEBAR_ROW_INTERACTION), so hover / focus / selected match
// exactly. Selected state is driven by `data-active` (not a class), like TreeRow.
const NAV_ROW = cn(
  'flex h-9 w-full items-center gap-2 rounded-sm px-2 text-body font-medium',
  SIDEBAR_ROW_INTERACTION,
)

export function AppSidebar() {
  const connectOpen = useConnectDialog((s) => s.open)
  const setConnectOpen = useConnectDialog((s) => s.setOpen)
  // Auth hooks stay mounted here because the connect dialogs live in this
  // component; Settings → Connections is the surface that shows/manages the
  // identities, so we only keep the `refresh` callbacks the dialogs need.
  const { refresh } = useClaudeAuth()
  const githubConnectOpen = useConnectGitHubDialog((s) => s.open)
  const setGithubConnectOpen = useConnectGitHubDialog((s) => s.setOpen)
  const { refresh: refreshGithub } = useGitHubAuth()
  // Every user signs in with Google, so the Profile row wears the Google
  // avatar + display name instead of a generic icon + "Profile" label.
  const { account: googleAccount } = useGoogleAuth()

  const createNew = useDocsStore((s) => s.createNew)
  const openPalette = useCommandPaletteStore((s) => s.openPalette)
  const startNewFolder = useNewFolderStore((s) => s.start)
  const sortMode = useSortStore((s) => s.mode)
  const setSortMode = useSortStore((s) => s.setMode)
  const inProgressOnly = useStatusFilterStore((s) => s.inProgressOnly)
  const setInProgressOnly = useStatusFilterStore((s) => s.setInProgressOnly)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  // Profile opens a note (not a route), so its active highlight tracks whether
  // the profile note is the currently-open doc — mirroring how the routed rows
  // light up via `pathname`.
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useActiveSlug()
  const activeDoc = knownDocs.find((d) => d.slug === activeSlug)
  const profileSlug = knownDocs.find(
    (d) => d.type === 'wiki:profile',
  )?.slug
  const profileActive = !!profileSlug && profileSlug === activeSlug

  // Keep a surface's nav row active not just on its list route, but also while
  // any of its files is the open doc — so drilling from the list page into a
  // specific skill/agent/command keeps the parent row highlighted. These dirs
  // mirror SKILLS_REL / AGENTS_REL / COMMANDS_REL (catalogued as 'note' docs,
  // whose relPath IS the file location).
  const activeRel = activeDoc?.relPath ?? null
  const inSurface = (dir: string) => !!activeRel && activeRel.startsWith(`${dir}/`)
  const agentsActive = pathname === '/agents' || inSurface('_system/agent/agents')
  const skillsActive = pathname === '/skills' || inSurface('_system/agent/skills')
  const commandActive =
    pathname === '/commands' || inSurface('_system/agent/commands')
  const galleryActive = pathname === '/gallery'
  const onboardActive = pathname === '/onboard'

  // Profile is lazily created — ensure the note exists, then open it in the
  // editor. `busy` guards the async gap so a double-click can't spawn two.
  const [profileBusy, setProfileBusy] = useState(false)
  const openProfile = useCallback(async () => {
    if (profileBusy) return
    setProfileBusy(true)
    try {
      const slug = await ensureProfileWikiSlug()
      if (!slug) return
      openDoc(slug)
    } catch (err) {
      console.warn('[sidebar] open profile failed', err)
    } finally {
      setProfileBusy(false)
    }
  }, [profileBusy])

  // New flat note (lands at inbox/Untitled.md) → open it. Shared by the
  // header "+" button and the ⌘N shortcut so there's one code path.
  const handleCreateNew = useCallback(() => {
    createNew().then((slug) => {
      openDoc(slug)
    }).catch((err) => console.error('[docs] createNew failed', err))
  }, [createNew])

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
        {/* Drag region fills the gap; the frequent file actions + Settings sit
            at the header's right edge (their original home). Outside the drag
            region so they stay clickable. */}
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
          <DropdownMenuContent side="bottom" align="end">
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
          aria-label="진행 중만 보기"
          title="진행 중만 보기"
          aria-pressed={inProgressOnly}
          onClick={() => setInProgressOnly(!inProgressOnly)}
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-md transition-colors',
            inProgressOnly
              ? 'bg-foreground/12 text-sidebar-foreground'
              : 'text-sidebar-foreground/60 hover:bg-foreground/12 hover:text-sidebar-foreground',
          )}
        >
          <IconCircleDashed size={18} stroke={1.75} />
        </button>
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
        <button
          type="button"
          aria-label="Settings"
          title="Settings (⌘,)"
          onClick={() => openSettings()}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-foreground/12 hover:text-sidebar-foreground"
        >
          <IconSettings size={18} stroke={1.75} />
        </button>
      </SidebarHeader>

      <SidebarContent>
        {/* On-demand agent / profile surfaces as a vertical list above the
            folder tree — icon + label rows. Lives INSIDE SidebarContent so it
            scrolls together with the tree (one scroll for the whole sidebar).
            Profile opens the self-note; the rest open their management pages. */}
        {/* Left gutter (pl-3 = 12px) so the ICON/TEXT left edge lands on the
            macOS traffic-light leading edge (~20px = 12px gutter + the row's
            8px inner pad). The hover/selection FILL starts at 12px and may
            spill a touch left of the lights — that's intentional; alignment
            tracks content, not the fill. Kept in sync with the folder tree's
            root <ul> below so both share one content line. */}
        {/* Small muted section label (title-case, aligned to the icon column at
            pl-5) — categorizes the top surfaces vs. the notes tree below. */}
        <div className="-mb-1 select-none px-5 pt-2 text-footnote font-semibold text-sidebar-foreground/50">
          Assistant
        </div>
        <nav className="flex flex-col gap-0.5 pl-3 pr-2">
          <button
            type="button"
            onClick={() => void openProfile()}
            data-active={profileActive || undefined}
            className={NAV_ROW}
          >
            <Avatar size="sm" className="size-[18px]">
              {googleAccount.picture ? (
                <AvatarImage
                  src={googleAccount.picture}
                  alt={googleAccount.name ?? 'Profile'}
                  referrerPolicy="no-referrer"
                />
              ) : null}
              <AvatarFallback>
                <IconUser size={12} stroke={1.75} />
              </AvatarFallback>
            </Avatar>
            <span className="flex-1 truncate text-left">
              {googleAccount.name ? `${googleAccount.name}'s profile` : 'Profile'}
            </span>
          </button>
          <button
            type="button"
            onClick={() => navigate('/agents')}
            data-active={agentsActive || undefined}
            className={NAV_ROW}
          >
            <IconRobot size={18} stroke={1.75} className="shrink-0" />
            <span className="flex-1 truncate text-left">Agents</span>
          </button>
          <button
            type="button"
            onClick={() => navigate('/skills')}
            data-active={skillsActive || undefined}
            className={NAV_ROW}
          >
            <IconBolt size={18} stroke={1.75} className="shrink-0" />
            <span className="flex-1 truncate text-left">Skills</span>
          </button>
          <button
            type="button"
            onClick={() => navigate('/commands')}
            data-active={commandActive || undefined}
            className={NAV_ROW}
          >
            <IconTerminal2 size={18} stroke={1.75} className="shrink-0" />
            <span className="flex-1 truncate text-left">Commands</span>
          </button>
          {/* DEV-only design tools — the gallery + onboarding preview are for
              iterating on UI, never shown to end users. */}
          {import.meta.env.DEV && (
            <>
              <button
                type="button"
                onClick={() => navigate('/gallery')}
                data-active={galleryActive || undefined}
                className={NAV_ROW}
              >
                <IconPalette size={18} stroke={1.75} className="shrink-0" />
                <span className="flex-1 truncate text-left">Gallery</span>
              </button>
              <button
                type="button"
                onClick={() => navigate('/onboard')}
                data-active={onboardActive || undefined}
                className={NAV_ROW}
              >
                <IconSparkles size={18} stroke={1.75} className="shrink-0" />
                <span className="flex-1 truncate text-left">Onboarding</span>
              </button>
            </>
          )}
        </nav>

        {/* Section label for the vault's notes, mirroring the "Assistant"
            label above so the two zones read as distinct groups. */}
        <div className="-mb-1 select-none px-5 pt-3 text-footnote font-semibold text-sidebar-foreground/50">
          Notes
        </div>
        {/* Obsidian-style folder tree — the vault's folder structure is
            the sidebar. (Replaced the day/week/month date views.) */}
        <FolderTree />
      </SidebarContent>
      <SidebarFooter className="p-0">
        <WhatsNewSidebar />
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
