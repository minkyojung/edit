import { useMemo } from 'react'
import {
  IconAlertTriangle,
  IconBrandReact,
  IconExternalLink,
  IconFile,
  IconFileCode,
  IconFileText,
  IconLoader2,
  IconSearch,
  IconTerminal2,
  IconTool,
  IconWorld,
} from '@tabler/icons-react'
import type { Icon } from '@tabler/icons-react'
import type { BundledLanguage } from 'shiki'
import type { ToolPart as ToolPartType } from '@/chat/types'
import { ActivityRow } from '@/chat/parts/ActivityRow'
import { CodeBlock } from '@/components/ai-elements/code-block'
import { humanizeToolCall } from '@/chat/humanizers'
import { useDocsStore } from '@/state/docsStore'
import { buildViewUrl } from '@/lib/viewUrl'
import { pathToKnownSlug } from '@/lib/docPaths'

/** Compact tool invocation row (Read / Bash / Grep / WebSearch / …). Renders
 * through the shared `ActivityRow` so it sits in the same visual column as the
 * thinking pills — a context icon + humanized label + a quiet state marker.
 * The tool is a receipt of what happened, not the star of the turn.
 *
 * On expand we show only the call's `input`; the (often huge) success `output`
 * is deliberately NOT dumped — for a web search that would flood the turn with
 * raw result JSON, and the model's answer already carries the synthesized
 * result. Errors are the exception: a failed call shows its error text.
 *
 * The built-in `Read` tool keeps its extra affordance: when the file_path
 * resolves to a known doc, an "open in editor" button switches the active
 * doc — the citation row doubles as navigation. */
export function ToolPart({ part }: { part: ToolPartType }) {
  const { label, chips } = humanizeToolCall(part.toolName, part.input, part.output)
  const Icon = iconForTool(part.toolName)

  // Detail is just the call's input as a syntax-highlighted code block — no
  // "input" / "output" labels, and the (often huge) success output is never
  // dumped. Errors are the exception so a failed call still says why.
  const inputCode = formatInput(part.input)
  const isError = part.state === 'output-error'
  const detail =
    inputCode || isError ? (
      <>
        {inputCode && <CodeBlock code={inputCode} language="json" />}
        {isError && (
          <CodeBlock
            code={String(part.errorText ?? part.output ?? '')}
            language={'text' as BundledLanguage}
          />
        )}
      </>
    ) : undefined

  // Subscribe so a freshly-loaded wiki page (race with the model's
  // first Read) lights up the open button as soon as it lands in knownDocs.
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const openSlug = useMemo(() => {
    if (part.toolName !== 'Read') return null
    const path = (part.input as { file_path?: string } | null | undefined)?.file_path
    if (!path || typeof path !== 'string') return null
    return pathToKnownSlug(path, knownDocs)
  }, [part.toolName, part.input, knownDocs])

  return (
    <ActivityRow
      icon={<Icon size={14} />}
      label={label}
      accessory={
        chips && chips.length > 0
          ? chips.map((chip, i) => <FileChip key={`${chip.name}-${i}`} name={chip.name} />)
          : undefined
      }
      trailing={
        <>
          {openSlug && (
            <button
              type="button"
              onClick={(e) => {
                // The row is itself a trigger; stop propagation so the icon
                // click stays a navigation action and doesn't toggle the body.
                e.stopPropagation()
                const store = useDocsStore.getState()
                window.location.hash = buildViewUrl({
                  tab: store.sidebarTab,
                  dayAnchor: store.dayAnchor,
                  monthAnchor: store.monthAnchor,
                  slug: openSlug,
                })
              }}
              aria-label="Open page in editor"
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <IconExternalLink size={12} />
            </button>
          )}
          <ToolStateMark state={part.state} />
        </>
      }
      detail={detail}
    />
  )
}

/** A file reference rendered as a bordered chip — a file-type icon + the
 * basename — shown next to the tool label (e.g. `Read 563 lines [⚛ App.tsx]`).
 * The name truncates so a long file name never blows out the row. */
function FileChip({ name }: { name: string }) {
  const Icon = iconForFile(name)
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[13px] text-muted-foreground">
      <Icon size={13} className="shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  )
}

/** Map a file name's extension to a type icon for its chip. */
function iconForFile(name: string): Icon {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'tsx':
    case 'jsx':
      return IconBrandReact
    case 'ts':
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'json':
    case 'css':
    case 'html':
    case 'py':
    case 'rs':
    case 'go':
      return IconFileCode
    case 'md':
    case 'mdx':
    case 'txt':
      return IconFileText
    default:
      return IconFile
  }
}

/** Format a tool's input for the code block — pretty JSON for objects, the raw
 * string otherwise. Empty / absent input returns '' so the row stays
 * non-expandable rather than showing an empty "{}". */
function formatInput(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input
  try {
    const json = JSON.stringify(input, null, 2)
    return json === '{}' ? '' : json
  } catch {
    return String(input)
  }
}

/** Quiet state marker — a spinner while the call is in flight, a warning on
 * error, and nothing once it completes cleanly (a settled row stays calm). */
function ToolStateMark({ state }: { state: ToolPartType['state'] }) {
  if (state === 'input-streaming' || state === 'input-available') {
    return <IconLoader2 size={12} className="shrink-0 animate-spin text-muted-foreground" />
  }
  if (state === 'output-error') {
    return <IconAlertTriangle size={12} className="shrink-0 text-destructive" />
  }
  if (state === 'approval-requested') {
    return <IconAlertTriangle size={12} className="shrink-0 text-amber-500" />
  }
  return null
}

/** Map a tool name to a context icon so the row reads at a glance. */
function iconForTool(toolName: string): Icon {
  switch (toolName) {
    case 'WebSearch':
      return IconSearch
    case 'WebFetch':
      return IconWorld
    case 'Read':
      return IconFileText
    case 'Grep':
      return IconSearch
    case 'Bash':
      return IconTerminal2
    default:
      return IconTool
  }
}
