// Sidebar "Tags" section — an Obsidian-style pane listing every tag in the
// vault with its note count. Clicking a tag filters the folder tree to notes
// carrying it (click again to clear). The tag list is a derived view of the
// catalog (see aggregateTags); the active-tag filter lives in tagFilterStore.

import { useMemo } from 'react'
import { IconTag } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useDocsStore } from '@/state/docsStore'
import { useTagFilterStore } from '@/state/tagFilterStore'
import { aggregateTags } from '@/lib/tags'
import { SIDEBAR_ROW_INTERACTION } from '@/components/ui/sidebarRow'

export function TagList() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeTag = useTagFilterStore((s) => s.activeTag)
  const toggleTag = useTagFilterStore((s) => s.toggleTag)
  const tags = useMemo(() => aggregateTags(knownDocs), [knownDocs])

  // No tags in the vault → no section (kept quiet until tags exist).
  if (tags.length === 0) return null

  return (
    <div className="pb-2">
      <div className="-mb-1 select-none px-5 pt-3 text-footnote font-medium text-sidebar-foreground/50">
        Tags
      </div>
      <div className="flex flex-col py-1 pl-3 pr-2">
        {tags.map(({ tag, count }) => (
          <button
            key={tag}
            type="button"
            data-active={activeTag === tag || undefined}
            onClick={() => toggleTag(tag)}
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-sm px-2 text-body font-normal',
              SIDEBAR_ROW_INTERACTION,
            )}
          >
            <IconTag size={15} stroke={1.75} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left">{tag}</span>
            <span className="shrink-0 text-footnote tabular-nums text-muted-foreground/70">
              {count}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
