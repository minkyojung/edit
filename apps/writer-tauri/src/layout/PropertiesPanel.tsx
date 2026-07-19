// Notion-style properties panel — the metadata block that sits between a
// note's title and its body. A quiet list of `[icon] label → value` rows,
// each a projection of one frontmatter-backed field. Tier A: only the fields
// already in the model, no arbitrary properties / type picker.
//
// The panel is a view; each value control read/writes its own field through
// the existing store actions (setDocStatus / setArticleRead) — no new setters.

import {
  IconCalendar,
  IconCircleDashed,
  IconClock,
  IconWorld,
} from '@tabler/icons-react'
import type { KnownDoc } from '@/state/docsStore'
import { useDocsStore } from '@/state/docsStore'
import { formatDate } from '@/lib/formatDate'
import { Switch } from '@/components/ui/switch'
import { PropertyRow } from './PropertyRow'
import { StatusControl } from './StatusControl'

export type PropKind = 'status' | 'created' | 'source' | 'read'

/** Which property rows a note shows. `status` is always present (every
 * editable note supports it); the rest appear only when their backing field
 * exists, so read-only rows never render as an empty line. */
export function visibleProps(
  known: Pick<KnownDoc, 'createdAt' | 'sourceUrl'>,
): PropKind[] {
  const rows: PropKind[] = ['status']
  if (known.createdAt) rows.push('created')
  if (known.sourceUrl) rows.push('source', 'read')
  return rows
}

export function PropertiesPanel({ slug, known }: { slug: string; known: KnownDoc }) {
  const setArticleRead = useDocsStore((s) => s.setArticleRead)
  const rows = visibleProps(known)

  return (
    <div className="mb-6 flex flex-col gap-0.5">
      {rows.map((kind) => {
        switch (kind) {
          case 'status':
            return (
              <PropertyRow key={kind} icon={IconCircleDashed} label="상태">
                <StatusControl slug={slug} status={known.status} />
              </PropertyRow>
            )
          case 'created':
            return (
              <PropertyRow key={kind} icon={IconCalendar} label="생성일">
                <span className="text-muted-foreground">
                  {formatDate(known.createdAt as string)}
                </span>
              </PropertyRow>
            )
          case 'source':
            return (
              <PropertyRow key={kind} icon={IconWorld} label="출처">
                <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  {known.faviconUrl ? (
                    <img
                      src={known.faviconUrl}
                      alt=""
                      className="size-3.5 shrink-0 rounded-sm"
                    />
                  ) : null}
                  <span className="truncate">{known.siteName ?? known.sourceUrl}</span>
                </span>
              </PropertyRow>
            )
          case 'read':
            return (
              <PropertyRow key={kind} icon={IconClock} label="읽음">
                <Switch
                  checked={!!known.readAt}
                  onCheckedChange={(v) => setArticleRead(slug, v)}
                  aria-label="읽음 표시"
                />
              </PropertyRow>
            )
        }
      })}
    </div>
  )
}
