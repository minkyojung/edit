import { useMemo } from 'react'
import {
  IconChevronDown,
  IconExternalLink,
  IconTool,
} from '@tabler/icons-react'
import type { ToolPart as ToolPartType } from '@/chat/types'
import { Tool, ToolContent } from '@/components/ai-elements/tool'
import { CollapsibleTrigger } from '@/components/ui/collapsible'
import { ToolStateBadge } from '@/chat/ui/ToolStateBadge'
import { KeyValueBlock } from '@/chat/ui/KeyValueBlock'
import { humanizeToolCall } from '@/chat/humanizers'
import { useDocsStore } from '@/state/docsStore'
import { buildViewUrl } from '@/lib/viewUrl'
import { pathToKnownSlug } from '@/lib/docPaths'

/** Generic tool invocation card (Read / Bash / Grep / …). Built on AI
 * Elements `Tool` so it lines up with `ProposeChangePart`; the body is
 * collapsed by default because generic tool I/O is rarely the thing the
 * user actually wants to read — it's there for inspection, not the
 * star of the turn.
 *
 * The built-in `Read` tool gets an extra affordance: when the file_path
 * the model passed resolves to a known doc, we show an "open in editor"
 * button on the header. Clicking it switches the active doc — the
 * same routing the wikilink click plugin uses — so the citation card
 * doubles as navigation. */
export function ToolPart({ part }: { part: ToolPartType }) {
  const { label } = humanizeToolCall(part.toolName, part.input, part.output)

  // Subscribe so a freshly-loaded wiki page (race with the model's
  // first Read) lights up the open button as soon as it lands
  // in knownDocs.
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const openSlug = useMemo(() => {
    if (part.toolName !== 'Read') return null
    const path = (part.input as { file_path?: string } | null | undefined)?.file_path
    if (!path || typeof path !== 'string') return null
    return pathToKnownSlug(path, knownDocs)
  }, [part.toolName, part.input, knownDocs])

  return (
    <Tool className="my-2 text-xs">
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 p-3 text-left">
        <IconTool size={12} className="shrink-0 text-muted-foreground" />
        <span className="text-foreground">{label}</span>
        <span className="ml-auto flex items-center gap-2">
          {openSlug && (
            <button
              type="button"
              onClick={(e) => {
                // The header is itself a CollapsibleTrigger; stopping
                // propagation here keeps the icon click strictly a
                // navigation action and avoids toggling the body open
                // as a side effect.
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
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <IconExternalLink size={12} />
            </button>
          )}
          <ToolStateBadge state={part.state} />
          <IconChevronDown
            size={12}
            className="shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          />
        </span>
      </CollapsibleTrigger>
      <ToolContent className="!p-3 !pt-0 !space-y-2">
        <KeyValueBlock label="input" value={part.input} />
        {(part.state === 'output-available' || part.state === 'output-error') && (
          <KeyValueBlock
            label={part.state === 'output-error' ? 'error' : 'output'}
            value={part.errorText ?? part.output}
          />
        )}
      </ToolContent>
    </Tool>
  )
}
