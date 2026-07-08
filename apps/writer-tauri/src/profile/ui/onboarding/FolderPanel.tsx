// Onboarding step — Choose where notes live (mandatory: no skip).
//
// Pure view: no window resize, no store, no side effects. Picking a folder is
// required to finish onboarding, so there's no skip and no translation-project
// fork here — just one clear action. The real launcher wires the folder pick;
// the /onboard design-preview renders this same panel with a no-op.

import { Button } from '@/components/ui/button'

interface Props {
  onChooseFolder: () => void
}

export function FolderPanel({ onChooseFolder }: Props) {
  return (
    <div className="grid h-full w-full grid-cols-2 bg-background">
      {/* Left: copy + action */}
      <div className="flex flex-col justify-center px-10 py-8">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-foreground">
          Where should your notes live?
        </h1>
        <p className="mb-8 text-body leading-relaxed text-muted-foreground">
          Pick a folder for your notes — or create a new one. It becomes your
          vault; everything you write lives there as plain Markdown you own.
        </p>
        <Button className="w-full" onClick={onChooseFolder}>
          Choose a folder for my notes
        </Button>
      </div>

      {/* Right: preview panel (placeholder — swap for a real image later) */}
      <div className="flex items-center justify-center p-4">
        <div className="flex h-full w-full items-center justify-center rounded-2xl bg-gradient-to-br from-muted/60 to-muted/20">
          <span className="text-footnote text-muted-foreground/60">Preview image</span>
        </div>
      </div>
    </div>
  )
}
