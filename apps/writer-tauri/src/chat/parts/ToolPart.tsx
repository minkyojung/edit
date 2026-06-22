import { useMemo } from 'react'
import {
  IconAlertTriangle,
  IconExternalLink,
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
import { FileChip } from '@/chat/parts/FileChip'
import { CodeBlock } from '@/components/ai-elements/code-block'
import { humanizeToolCall, readOutputText } from '@/chat/humanizers'
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

  // Detail is a single syntax-highlighted code block — no "input" / "output"
  // labels. For Read we show the actual lines read, with their real file line
  // numbers in the gutter (the point of the call), highlighted by the file's
  // language; for every other tool we show the input params and never dump the
  // (often huge) success output — a web search would flood the turn, and the
  // answer already carries the result. Errors are always surfaced.
  const isError = part.state === 'output-error'
  const filePath = (part.input as { file_path?: string } | null | undefined)?.file_path ?? ''
  const read = part.toolName === 'Read' && !isError ? parseReadContent(readOutputText(part.output)) : null
  const inputCode = formatInput(part.input)
  // Tighten the shared CodeBlock's generous p-4 so the numbered content fills
  // the box. (Only the <pre> padding — overriding the line-number gutter would
  // also hit every token span's ::before and wreck inline spacing.)
  const codeClass = 'max-h-80 [&_pre]:px-3 [&_pre]:py-2.5'
  const detail =
    read?.code || inputCode || isError ? (
      <>
        {read?.code ? (
          <CodeBlock
            code={read.code}
            language={languageForPath(filePath)}
            showLineNumbers
            startLineNumber={read.startLine}
            className={codeClass}
          />
        ) : (
          inputCode && <CodeBlock code={inputCode} language="json" className={codeClass} />
        )}
        {isError && (
          <CodeBlock
            code={String(part.errorText ?? part.output ?? '')}
            language={'text' as BundledLanguage}
            className={codeClass}
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

/** Map a file path's extension to a shiki language for the read-content block.
 * Unknown extensions fall back to plain text (shiki highlights nothing). */
function languageForPath(path: string): BundledLanguage {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
    json: 'json', md: 'markdown', mdx: 'markdown', txt: 'text',
    py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java',
    sh: 'bash', bash: 'bash', zsh: 'bash', css: 'css', scss: 'scss',
    html: 'html', yaml: 'yaml', yml: 'yaml', toml: 'toml', sql: 'sql',
  }
  return (map[ext] ?? 'text') as BundledLanguage
}

/** The SDK's Read returns content in `cat -n` form: each line is
 * `   <n>\t<content>`. Parse out the real first line number and the bare
 * content so we can render a proper line-number gutter starting at <n>.
 * Only treated as guttered when EVERY non-empty line carries it (so real
 * content that merely starts with a number is left untouched). */
function parseReadContent(text: string | null): { code: string; startLine: number } | null {
  if (!text) return null
  const lines = text.split('\n')
  const nonEmpty = lines.filter((l) => l.length > 0)
  const gutter = /^\s*(\d+)\t(.*)$/
  if (nonEmpty.length === 0 || !nonEmpty.every((l) => /^\s*\d+\t/.test(l))) {
    return { code: text, startLine: 1 }
  }
  let startLine: number | null = null
  const code = lines
    .map((l) => {
      const m = gutter.exec(l)
      if (!m) return l
      if (startLine === null) startLine = Number(m[1])
      return m[2]
    })
    .join('\n')
  return { code, startLine: startLine ?? 1 }
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
