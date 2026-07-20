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
  IconTag,
  IconWorld,
} from '@tabler/icons-react'
import type { KnownDoc } from '@/state/docsStore'
import { useDocsStore } from '@/state/docsStore'
import { Switch } from '@/components/ui/switch'
import { PropertyRow } from './PropertyRow'
import { StatusControl } from './StatusControl'
import { TagInput } from './TagInput'
import { visibleProps } from './propertyRows'

export function PropertiesPanel({ slug, known }: { slug: string; known: KnownDoc }) {
  const setArticleRead = useDocsStore((s) => s.setArticleRead)
  const setDocTags = useDocsStore((s) => s.setDocTags)
  const rows = visibleProps(known)

  return (
    <div className="mb-6 flex flex-col gap-0.5">
      {rows.map((kind) => {
        switch (kind) {
          case 'status':
            return (
              <PropertyRow key={kind} icon={IconCircleDashed} label="status">
                <StatusControl slug={slug} status={known.status} />
              </PropertyRow>
            )
          case 'tags':
            return (
              <PropertyRow key={kind} icon={IconTag} label="tags">
                <TagInput
                  tags={known.tags ?? []}
                  onChange={(next) => setDocTags(slug, next)}
                />
              </PropertyRow>
            )
          case 'created':
            return (
              // Obsidian-style: the frontmatter key name and its raw on-disk
              // value (the full ISO timestamp), not a localized/prettified form.
              <PropertyRow key={kind} icon={IconCalendar} label="created">
                <span className="text-muted-foreground">{known.createdAt}</span>
              </PropertyRow>
            )
          case 'source':
            return (
              <PropertyRow key={kind} icon={IconWorld} label="source">
                <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  {known.faviconUrl ? (
                    <img
                      src={known.faviconUrl}
                      alt=""
                      className="size-3.5 shrink-0 rounded-sm"
                    />
                  ) : null}
                  <span className="truncate">{known.sourceUrl}</span>
                </span>
              </PropertyRow>
            )
          case 'read':
            return (
              <PropertyRow key={kind} icon={IconClock} label="readAt">
                <Switch
                  checked={!!known.readAt}
                  onCheckedChange={(v) => setArticleRead(slug, v)}
                  aria-label="readAt"
                />
              </PropertyRow>
            )
        }
      })}
    </div>
  )
}
