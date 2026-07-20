// Header status control — a small badge that shows a note's workflow
// status and, when clicked, opens a menu to change or clear it. Rendered
// in PageHeader for editable notes only.

import { cn } from '@/lib/utils'
import { badgeVariants } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useDocsStore } from '@/state/docsStore'
import { DOC_STATUS_VALUES, type DocStatus } from '@/lib/docPaths'
import { STATUS_BADGE_VARIANT, STATUS_LABEL } from '@/lib/docStatusMeta'

export function StatusControl({
  slug,
  status,
}: {
  slug: string
  status?: DocStatus
}) {
  const setDocStatus = useDocsStore((s) => s.setDocStatus)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="status"
          className={cn(
            badgeVariants({ variant: status ? STATUS_BADGE_VARIANT[status] : 'outline' }),
            // Bump past the badge defaults (h-5/text-xs) so the pill reads
            // at the value row's scale, not a tiny tag.
            'h-7 cursor-pointer px-2.5 text-callout',
            !status && 'text-muted-foreground',
          )}
        >
          {status ? STATUS_LABEL[status] : '＋ 상태'}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start">
        <DropdownMenuRadioGroup
          value={status ?? ''}
          onValueChange={(v) => setDocStatus(slug, v as DocStatus)}
        >
          {DOC_STATUS_VALUES.map((s) => (
            <DropdownMenuRadioItem key={s} value={s}>
              {STATUS_LABEL[s]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {status && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setDocStatus(slug, undefined)}>
              상태 없음
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
