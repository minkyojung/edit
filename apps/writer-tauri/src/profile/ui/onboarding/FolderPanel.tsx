// Onboarding step — Choose where notes live (mandatory: no skip).
//
// Unlike the welcome/connect steps (2-column "sell" screens), this is the "do"
// step: a single centred column with one focused folder drop-zone. The card
// looks like a drop target but click-opens the native picker (real drag-and-drop
// can be layered on later). Pure view: the launcher wires the pick; the /onboard
// preview renders it with a no-op.

import { IconFolder } from '@tabler/icons-react'
import { cn } from '@/lib/utils'

interface Props {
  onChooseFolder: () => void
  /** True while a folder is being dragged over the window — highlights the drop
   * target. Wired by the launcher; the /onboard preview leaves it off. */
  dragActive?: boolean
}

export function FolderPanel({ onChooseFolder, dragActive }: Props) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background px-8">
      <div className="w-full max-w-[420px] text-center">
        <h1 className="mb-3 text-3xl font-bold leading-tight tracking-tight text-foreground">
          Where should your notes live?
        </h1>
        <p className="mb-8 text-body leading-relaxed text-muted-foreground">
          Pick a folder — or make a new one. It becomes your vault: plain Markdown
          you own.
        </p>

        {/* The folder card IS the action — drop a folder from Finder onto it, or
            click to open the native picker. */}
        <button
          type="button"
          onClick={onChooseFolder}
          className={cn(
            'flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 transition-colors',
            dragActive
              ? 'border-foreground/60 bg-muted/60'
              : 'border-border hover:border-foreground/40 hover:bg-muted/40',
          )}
        >
          <span className="mb-1 flex size-12 items-center justify-center rounded-xl bg-foreground/5 text-foreground">
            <IconFolder size={26} stroke={1.75} />
          </span>
          <span className="text-body font-medium text-foreground">
            {dragActive ? 'Drop your folder' : 'Choose a folder'}
          </span>
          <span className="text-footnote text-muted-foreground">
            {dragActive ? 'Release to use it as your vault' : 'drag one here, or create a new one'}
          </span>
        </button>
      </div>
    </div>
  )
}
