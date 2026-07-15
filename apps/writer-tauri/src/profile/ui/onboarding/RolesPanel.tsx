// Onboarding step — map the two roles to real folders.
//
// After the user picks a vault, this step reads its top-level folders and
// asks which one holds durable knowledge and which one holds quick
// captures. No AI: just the real directory listing (plus the role
// defaults) in two dropdowns, pre-selected to sensible defaults and
// editable in one click. The launcher wires the choices to the
// knowledgeBaseFolder / defaultNoteFolder settings; the /onboard preview
// renders it with no-ops.

import type { ReactNode } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface Props {
  /** Selectable folder names — the vault's real folders plus the role
   * defaults (see {@link folderOptions}). */
  options: string[]
  knowledgeBase: string
  capture: string
  onKnowledgeBaseChange: (folder: string) => void
  onCaptureChange: (folder: string) => void
  onContinue: () => void
  /** Step-progress indicator, rendered (centred) above the headline. */
  progress?: ReactNode
}

export function RolesPanel({
  options,
  knowledgeBase,
  capture,
  onKnowledgeBaseChange,
  onCaptureChange,
  onContinue,
  progress,
}: Props) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background px-8">
      <div className="w-full max-w-[420px] text-center">
        {progress && <div className="mb-6 flex justify-center">{progress}</div>}
        <h1 className="mb-3 text-3xl font-bold leading-tight tracking-tight text-foreground">
          Where does what go?
        </h1>
        <p className="mb-8 text-body leading-relaxed text-muted-foreground">
          Pick the folders for your two main roles. You can change these anytime
          in settings.
        </p>

        <div className="space-y-4 text-left">
          <RoleRow
            title="Knowledge base"
            hint="Durable, organized notes the assistant keeps coherent."
            value={knowledgeBase}
            options={options}
            onChange={onKnowledgeBaseChange}
          />
          <RoleRow
            title="Capture"
            hint="Quick, unsorted notes waiting to be filed."
            value={capture}
            options={options}
            onChange={onCaptureChange}
          />
        </div>

        <button
          type="button"
          onClick={onContinue}
          className="mt-8 w-full rounded-xl bg-foreground px-6 py-3 text-body font-medium text-background transition-opacity hover:opacity-90"
        >
          Continue
        </button>
      </div>
    </div>
  )
}

function RoleRow({
  title,
  hint,
  value,
  options,
  onChange,
}: {
  title: string
  hint: string
  value: string
  options: string[]
  onChange: (folder: string) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3">
      <div className="min-w-0">
        <div className="text-body font-medium text-foreground">{title}</div>
        <div className="truncate text-footnote text-muted-foreground">{hint}</div>
      </div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-36 shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((f) => (
            <SelectItem key={f} value={f}>
              {f}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
