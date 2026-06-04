// First-run launcher (Obsidian-style "open vault" screen). Shown by BootGate
// when no vault is selected yet, BEFORE git init / bootstrap touch the folder —
// which is the only point restore can run (once the app fills an empty folder
// it's no longer restorable). Two paths:
//
//   1. Open a local folder (new vault, or an existing Writer vault).
//   2. Restore from GitHub — connect (inline device flow, since the normal
//      connect dialog lives post-boot in the Sidebar), list the user's repos,
//      pick one, choose an empty destination folder, clone it down.
//
// Calls `onReady` once a vault is in place so BootGate proceeds with the normal
// boot sequence (git init is idempotent — a restore's clone already made .git).

import { useCallback, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ConnectGitHubDialog } from '@/components/auth/ConnectGitHubDialog'
import { useGitHubAuth } from '@/hooks/useGitHubAuth'
import { pickVault } from '@/lib/vaultPicker'
import { listMyRepos, restoreFromGitHub, type RepoSummary } from '@/lib/vaultRestore'

interface Props {
  /** Fired once a vault is ready (picked locally or restored) so BootGate runs
   * the normal boot sequence. */
  onReady: () => void
}

export function VaultLauncher({ onReady }: Props) {
  const { account, refresh } = useGitHubAuth()
  const [mode, setMode] = useState<'home' | 'repos'>('home')
  const [connectOpen, setConnectOpen] = useState(false)
  const [repos, setRepos] = useState<RepoSummary[]>([])
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleLocal = useCallback(async () => {
    const path = await pickVault()
    if (path) onReady()
  }, [onReady])

  const loadRepos = useCallback(async () => {
    setLoadingRepos(true)
    try {
      setRepos(await listMyRepos())
      setMode('repos')
    } finally {
      setLoadingRepos(false)
    }
  }, [])

  const handleRestoreClick = useCallback(() => {
    if (account.connected) void loadRepos()
    else setConnectOpen(true)
  }, [account.connected, loadRepos])

  const handlePickRepo = useCallback(
    async (repo: RepoSummary) => {
      // Restore clones into an empty folder — let the user choose where.
      const path = await pickVault()
      if (!path) return
      setBusy(true)
      try {
        const ok = await restoreFromGitHub(repo)
        if (ok) onReady()
      } finally {
        setBusy(false)
      }
    },
    [onReady],
  )

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-center text-2xl font-semibold tracking-tight text-foreground">
          Writer
        </h1>
        <p className="mb-6 text-center text-sm text-muted-foreground">
          {mode === 'home'
            ? '보관함을 열거나 백업에서 복원하세요.'
            : '복원할 저장소를 고르세요.'}
        </p>

        <div className="rounded-xl border bg-card p-2">
          {mode === 'home' ? (
            <>
              <LauncherRow
                title="폴더 열기 / 새로 시작"
                desc="이 컴퓨터의 폴더를 보관함으로 사용합니다."
                action={<Button onClick={() => void handleLocal()}>열기</Button>}
              />
              <LauncherRow
                title="GitHub에서 복원"
                desc="다른 기기에서 백업한 노트를 가져옵니다."
                action={
                  <Button
                    variant="secondary"
                    onClick={handleRestoreClick}
                    disabled={loadingRepos}
                  >
                    {loadingRepos ? <Spinner /> : '복원'}
                  </Button>
                }
              />
            </>
          ) : (
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => setMode('home')}
                className="mb-1 px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                ← 뒤로
              </button>
              {repos.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  백업된 저장소가 없어요.
                </p>
              ) : (
                <div className="max-h-72 overflow-y-auto">
                  {repos.map((r) => (
                    <button
                      key={r.fullName}
                      type="button"
                      disabled={busy}
                      onClick={() => void handlePickRepo(r)}
                      className="block w-full truncate rounded-md px-3 py-2 text-left text-sm text-foreground hover:bg-muted disabled:opacity-50"
                      title={r.fullName}
                    >
                      {r.fullName}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <ConnectGitHubDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={() => {
          void refresh()
          void loadRepos()
        }}
      />
    </div>
  )
}

function LauncherRow({
  title,
  desc,
  action,
}: {
  title: string
  desc: string
  action: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg p-3 hover:bg-muted/40">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
      <div className="flex-none">{action}</div>
    </div>
  )
}
