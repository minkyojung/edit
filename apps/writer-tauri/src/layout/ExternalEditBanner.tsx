// Banner surface for the external-edit conflict state.
//
// Renders above the editor for the active slug when its file has
// been modified externally (VSCode, Obsidian, iCloud sync, etc.)
// while the local Y.Doc has unsaved edits. Two resolutions:
//
//   Reopen   → discard local Y.Doc state, re-read disk file.
//              The "external wins" path. Unsaved local edits are lost.
//   Dismiss  → clear the conflict and let auto-flush resume.
//              The "local wins" path. The external edit is overwritten
//              on the next flush tick.
//
// While the banner is up, `docFileSync.flushDirty` skips this slug
// (see externalConflictStore.ts) so auto-flush can't silently pick a
// side before the user decides.

import { useDocsStore } from '@/state/docsStore'
import { useExternalConflictStore } from '@/state/externalConflictStore'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function ExternalEditBanner() {
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const conflicts = useExternalConflictStore((s) => s.conflicts)
  const resolveConflict = useExternalConflictStore((s) => s.resolveConflict)
  const reloadFromVault = useDocsStore((s) => s.reloadFromVault)

  if (!activeSlug || !conflicts.has(activeSlug)) return null

  const onReopen = async () => {
    // Reload first, then clear the conflict. Order matters: clearing
    // first would let an auto-flush tick race in between (the slug is
    // still dirty until reloadFromVault wipes its Y.Doc state) and
    // overwrite the external version.
    await reloadFromVault(activeSlug)
    resolveConflict(activeSlug)
  }

  const onDismiss = () => {
    resolveConflict(activeSlug)
  }

  return (
    <div
      role="alert"
      className={cn(
        'mx-auto mt-4 mb-2 max-w-prose rounded-lg border border-amber-500/40',
        'bg-amber-500/10 p-3 text-sm text-foreground',
      )}
    >
      <div className="mb-2 font-medium">
        이 파일이 외부에서 수정되었습니다.
      </div>
      <div className="mb-3 text-muted-foreground">
        Writer 안에서 편집 중인 내용과 디스크의 내용이 다릅니다. 둘 중 하나만
        남길 수 있습니다.
      </div>
      <div className="flex gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={() => {
            void onReopen()
          }}
        >
          다시 불러오기 (디스크 버전 사용)
        </Button>
        <Button variant="outline" size="sm" onClick={onDismiss}>
          무시하고 계속 (내 편집 유지)
        </Button>
      </div>
    </div>
  )
}
